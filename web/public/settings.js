// ORDERLY settings.
//
// The page holds a draft, the server holds the truth. Nothing is written until
// the operator reads a plain-English list of what will change and says so; the
// server then re-checks every one of those changes against its own allowlist
// before touching the file, so this page is a convenience, not an authority.
//
// No credential is ever rendered, requested or held here. Where a provider needs
// one, the page shows the environment variable's NAME and whether it is set.

import { DEFAULT_THEME, THEMES, getTheme, setTheme } from "./themes.js";

const el = (id) => document.getElementById(id);

function add(parent, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  parent.appendChild(node);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// --- state -----------------------------------------------------------------

let base = null; // as the server last reported it
let draft = null; // what the operator has typed

function makeDraft(payload) {
  const d = {
    defaults: {
      primary: payload.editable.defaults.primary,
      fallbacks: [...payload.editable.defaults.fallbacks],
      utilityModel: payload.editable.defaults.utilityModel,
    },
    agents: {},
    tags: {},
    replyStyle: structuredClone(payload.replyStyle?.value || {
      station: { instructions: "", presets: {} },
      agents: {},
    }),
  };
  for (const a of payload.editable.agents) d.agents[a.id] = a.primary;
  for (const p of payload.editable.providers) {
    d.tags[p.id] = p.models.map((m) => ({ id: m.id, name: m.name }));
  }
  return d;
}

// Every model the station can currently name, using the draft's tags so a
// renamed tag is selectable immediately.
function options() {
  const out = [];
  for (const p of base.editable.providers) {
    const tags = draft.tags[p.id] || [];
    tags.forEach((t, i) => {
      const source = p.models[i] || {};
      out.push({
        ref: `${p.id}/${t.id}`,
        label: t.name || t.id,
        detail: `${p.id} · ${t.id}`,
        reasoning: source.reasoning === true,
      });
    });
  }
  return out;
}

function labelFor(ref) {
  const hit = options().find((o) => o.ref === ref);
  return hit ? hit.label : ref || "—";
}

// Renaming a tag moves every reference that pointed at it, so the draft never
// holds a reference the server would reject.
function retarget(oldRef, newRef) {
  if (oldRef === newRef) return;
  if (draft.defaults.primary === oldRef) draft.defaults.primary = newRef;
  if (draft.defaults.utilityModel === oldRef) draft.defaults.utilityModel = newRef;
  draft.defaults.fallbacks = draft.defaults.fallbacks.map((f) => (f === oldRef ? newRef : f));
  for (const id of Object.keys(draft.agents)) {
    if (draft.agents[id] === oldRef) draft.agents[id] = newRef;
  }
}

// --- the change list -------------------------------------------------------
//
// One pass produces both what the operator reads and what the server is sent,
// so the two can't drift apart.

function diff() {
  const changes = [];
  const edits = {};
  const b = base.editable;

  const defaults = {};
  if (draft.defaults.primary !== b.defaults.primary) {
    defaults.primary = draft.defaults.primary;
    changes.push({
      what: "Main model",
      from: labelFor(b.defaults.primary),
      to: labelFor(draft.defaults.primary),
    });
  }
  if (draft.defaults.utilityModel !== b.defaults.utilityModel) {
    defaults.utilityModel = draft.defaults.utilityModel;
    changes.push({
      what: "Utility model",
      from: labelFor(b.defaults.utilityModel),
      to: labelFor(draft.defaults.utilityModel),
    });
  }
  if (JSON.stringify(draft.defaults.fallbacks) !== JSON.stringify(b.defaults.fallbacks)) {
    defaults.fallbacks = draft.defaults.fallbacks;
    changes.push({
      what: "Fallbacks",
      from: b.defaults.fallbacks.map(labelFor).join(", ") || "none",
      to: draft.defaults.fallbacks.map(labelFor).join(", ") || "none",
    });
  }
  if (Object.keys(defaults).length) edits.defaults = defaults;

  const agents = {};
  for (const a of b.agents) {
    const now = draft.agents[a.id] ?? null;
    if (now !== (a.primary ?? null)) {
      agents[a.id] = now;
      changes.push({
        what: `Model for ${a.id}`,
        from: a.primary ? labelFor(a.primary) : "the station default",
        to: now ? labelFor(now) : "the station default",
      });
    }
  }
  if (Object.keys(agents).length) edits.agents = agents;

  const tags = {};
  for (const p of b.providers) {
    const drafted = draft.tags[p.id] || [];
    p.models.forEach((m, i) => {
      const patch = {};
      if (drafted[i]?.id !== m.id) patch.id = drafted[i].id;
      if (drafted[i]?.name !== m.name) patch.name = drafted[i].name;
      if (!Object.keys(patch).length) return;
      tags[p.id] ??= {};
      tags[p.id][String(i)] = patch;
      changes.push({
        what: `${p.id} model ${i + 1}`,
        from: `${m.id}${m.name ? ` (${m.name})` : ""}`,
        to: `${drafted[i].id}${drafted[i].name ? ` (${drafted[i].name})` : ""}`,
      });
    });
  }
  if (Object.keys(tags).length) edits.modelTags = tags;

  const originalStyle = base.replyStyle?.value || { station: { instructions: "", presets: {} }, agents: {} };
  if (JSON.stringify(draft.replyStyle.station) !== JSON.stringify(originalStyle.station)) {
    edits.replyStyle ??= {};
    edits.replyStyle.station = structuredClone(draft.replyStyle.station);
    changes.push({
      what: "Station reply style",
      from: "current wording",
      to: "the reviewed instructions and presets",
    });
  }
  const styleAgents = new Set([
    ...Object.keys(originalStyle.agents || {}),
    ...Object.keys(draft.replyStyle.agents || {}),
  ]);
  for (const agentId of styleAgents) {
    const before = originalStyle.agents?.[agentId] ?? null;
    const after = draft.replyStyle.agents?.[agentId] ?? null;
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    edits.replyStyle ??= {};
    edits.replyStyle.agents ??= {};
    edits.replyStyle.agents[agentId] = after === null ? null : structuredClone(after);
    changes.push({
      what: `Reply style for ${agentId}`,
      from: before ? "an agent-specific override" : "the station style",
      to: after ? "the reviewed agent-specific override" : "the station style",
    });
  }

  return { changes, edits };
}

function refreshSaveBar() {
  const { changes } = diff();
  const bar = el("savebar");
  bar.hidden = changes.length === 0 || !base.writable;
  el("savebar-count").textContent =
    changes.length === 1 ? "1 change" : `${changes.length} changes`;
}

// --- controls --------------------------------------------------------------

function modelSelect(value, onPick, { allowDefault = false } = {}) {
  const select = document.createElement("select");
  select.className = "select";
  if (allowDefault) {
    const opt = add(select, "option", null, "The station default");
    opt.value = "";
  }
  for (const o of options()) {
    const opt = add(select, "option", null, o.reasoning ? `${o.label} · reasoning` : o.label);
    opt.value = o.ref;
  }
  // A value the config holds but the catalogue no longer offers still has to be
  // shown, or the page would silently misreport what the station is running.
  if (value && !options().some((o) => o.ref === value)) {
    const opt = add(select, "option", null, `${value} (not in the catalogue)`);
    opt.value = value;
  }
  select.value = value ?? "";
  select.disabled = !base.writable;
  select.addEventListener("change", () => {
    onPick(select.value || null);
    render();
  });
  return select;
}

function field(parent, name, note, control) {
  const row = add(parent, "div", "field");
  const text = add(row, "div", "field__text");
  add(text, "span", "field__name", name);
  if (note) add(text, "span", "field__note", note);
  const holder = add(row, "div", "field__control");
  holder.appendChild(control);
  return row;
}

// --- panels ----------------------------------------------------------------

function renderAppearance(message = "") {
  const host = el("theme-grid");
  clear(host);
  const selected = getTheme();
  for (const theme of THEMES) {
    const button = add(host, "button", `theme-choice${theme.id === selected ? " is-on" : ""}`);
    button.type = "button";
    button.setAttribute("aria-pressed", String(theme.id === selected));
    button.setAttribute("aria-label", `Use ${theme.name} theme`);

    const preview = add(button, "span", "theme-choice__preview");
    const mascot = add(preview, "img", "theme-choice__mascot");
    mascot.src = theme.mascot;
    mascot.alt = "";
    mascot.width = 52;
    mascot.height = 52;
    const colors = add(preview, "span", "theme-choice__swatches");
    for (const color of theme.swatches) {
      const swatch = add(colors, "span", "theme-choice__swatch");
      swatch.style.backgroundColor = color;
    }

    const copy = add(button, "span", "theme-choice__copy");
    add(copy, "span", "theme-choice__name", theme.name);
    add(copy, "span", "theme-choice__note", theme.note);
    add(copy, "span", "theme-choice__candidate", theme.candidate);
    button.addEventListener("click", () => {
      const result = setTheme(theme.id);
      renderAppearance(
        result.persisted
          ? `${theme.name} selected · saved in this browser.`
          : `${theme.name} selected for this page, but this browser refused storage.`,
      );
    });
  }
  el("theme-state").textContent = message ||
    (selected === DEFAULT_THEME
      ? "Night Desk is active · no theme preference is stored."
      : `${THEMES.find((theme) => theme.id === selected)?.name} is active · saved in this browser.`);
}

function renderModels() {
  const host = el("defaults-fields");
  clear(host);

  field(
    host,
    "Main model",
    "The one he answers with.",
    modelSelect(draft.defaults.primary, (v) => {
      draft.defaults.primary = v;
      draft.defaults.fallbacks = draft.defaults.fallbacks.filter((f) => f !== v);
    }),
  );

  field(
    host,
    "Utility model",
    "Small internal jobs — titles, summaries, routing.",
    modelSelect(draft.defaults.utilityModel, (v) => {
      draft.defaults.utilityModel = v;
    }),
  );

  const fbRow = add(host, "div", "field field--stack");
  const fbText = add(fbRow, "div", "field__text");
  add(fbText, "span", "field__name", "Fallbacks");
  add(fbText, "span", "field__note", "Tried in order when the main model won't answer.");
  const list = add(fbRow, "div", "fallbacks");
  for (const o of options()) {
    if (o.ref === draft.defaults.primary) continue;
    const on = draft.defaults.fallbacks.includes(o.ref);
    const chip = add(list, "button", `pick${on ? " is-on" : ""}`);
    chip.type = "button";
    chip.disabled = !base.writable;
    const order = draft.defaults.fallbacks.indexOf(o.ref);
    if (on) add(chip, "span", "pick__order", order + 1);
    add(chip, "span", "pick__label", o.label);
    chip.addEventListener("click", () => {
      draft.defaults.fallbacks = on
        ? draft.defaults.fallbacks.filter((f) => f !== o.ref)
        : [...draft.defaults.fallbacks, o.ref].slice(0, 6);
      render();
    });
  }
  if (!draft.defaults.fallbacks.length) {
    add(fbRow, "p", "field__warn", "No fallbacks: if the main model is down, he's down.");
  }

  const agentHost = el("agent-fields");
  clear(agentHost);
  for (const a of base.editable.agents) {
    const duty = base.duty.agents.find((d) => d.id === a.id);
    field(
      agentHost,
      a.id,
      duty ? `${duty.profile ?? "—"} tools · ${duty.sandboxMode === "all" ? "sandboxed" : "not sandboxed"}` : null,
      modelSelect(
        draft.agents[a.id],
        (v) => {
          draft.agents[a.id] = v;
        },
        { allowDefault: true },
      ),
    );
  }
}

function ensureAgentStyle(agentId) {
  draft.replyStyle.agents[agentId] ??= { instructions: "", presets: {} };
  return draft.replyStyle.agents[agentId];
}

function renderReplyStyle() {
  const station = draft.replyStyle.station;
  const textarea = el("reply-instructions");
  textarea.value = station.instructions || "";
  textarea.disabled = !base.writable;
  textarea.oninput = () => {
    station.instructions = textarea.value;
    el("reply-count").textContent = `${new TextEncoder().encode(textarea.value).length} / 8192 bytes`;
    renderReplyPreview();
    refreshSaveBar();
  };
  el("reply-count").textContent = `${new TextEncoder().encode(textarea.value).length} / 8192 bytes`;

  const presetHost = el("reply-presets");
  clear(presetHost);
  for (const preset of base.replyStyle.presets || []) {
    const on = station.presets?.[preset.id] === true;
    const button = add(presetHost, "button", `style-preset${on ? " is-on" : ""}`);
    button.type = "button";
    button.disabled = !base.writable;
    button.setAttribute("aria-pressed", String(on));
    add(button, "span", "style-preset__label", preset.label);
    add(button, "span", "style-preset__sentence", preset.sentence);
    button.addEventListener("click", () => {
      station.presets[preset.id] = !on;
      renderReplyStyle();
      refreshSaveBar();
    });
  }

  const agentHost = el("reply-agents");
  clear(agentHost);
  for (const agentId of base.replyStyle.eligibleAgents || []) {
    const current = draft.replyStyle.agents?.[agentId] ?? null;
    const box = add(agentHost, "details", "style-agent");
    const summary = add(box, "summary", "style-agent__summary");
    add(summary, "span", "style-agent__name", agentId);
    add(summary, "span", "style-agent__state", current ? "has an override" : "inherits station settings");
    const body = add(box, "div", "style-agent__body");
    const input = add(body, "textarea", "style-text");
    input.rows = 4;
    input.maxLength = 8192;
    input.placeholder = "Optional instructions for this agent only";
    input.value = current?.instructions || "";
    input.disabled = !base.writable;
    input.addEventListener("input", () => {
      ensureAgentStyle(agentId).instructions = input.value;
      renderReplyPreview();
      refreshSaveBar();
    });

    const overrides = add(body, "div", "style-overrides");
    for (const preset of base.replyStyle.presets || []) {
      const row = add(overrides, "label", "style-override");
      add(row, "span", null, preset.label);
      const select = add(row, "select", "select");
      select.disabled = !base.writable;
      for (const [value, label] of [["inherit", "Inherit"], ["on", "On"], ["off", "Off"]]) {
        const option = add(select, "option", null, label);
        option.value = value;
      }
      const state = current?.presets?.[preset.id];
      select.value = state === true ? "on" : state === false ? "off" : "inherit";
      select.addEventListener("change", () => {
        const record = ensureAgentStyle(agentId);
        if (select.value === "inherit") delete record.presets[preset.id];
        else record.presets[preset.id] = select.value === "on";
        renderReplyPreview();
        refreshSaveBar();
      });
    }
    const clearButton = add(body, "button", "ghost", "Clear override");
    clearButton.type = "button";
    clearButton.disabled = !base.writable || !current;
    clearButton.addEventListener("click", () => {
      delete draft.replyStyle.agents[agentId];
      renderReplyStyle();
      refreshSaveBar();
    });
  }

  el("reply-fault").hidden = !base.replyStyle.fault;
  el("reply-fault").textContent = base.replyStyle.fault
    ? `Stored reply style is invalid and will be omitted from prompts: ${base.replyStyle.fault}`
    : "";
  renderReplyPreview();
}

function renderReplyPreview() {
  const lines = [];
  const byId = new Map((base.replyStyle.presets || []).map((preset) => [preset.id, preset]));
  for (const [id, on] of Object.entries(draft.replyStyle.station.presets || {})) {
    if (on && byId.has(id)) lines.push(byId.get(id).sentence);
  }
  if (draft.replyStyle.station.instructions) lines.push(draft.replyStyle.station.instructions);
  for (const [agentId, record] of Object.entries(draft.replyStyle.agents || {})) {
    const changes = [];
    for (const [id, state] of Object.entries(record.presets || {})) {
      const preset = byId.get(id);
      if (preset) changes.push(`${state ? "On" : "Off"}: ${preset.label}`);
    }
    if (record.instructions) changes.push(record.instructions);
    if (changes.length) lines.push(`${agentId}: ${changes.join(" · ")}`);
  }
  el("reply-preview").textContent = lines.length
    ? lines.join("\n\n")
    : "No editable style instructions are enabled. The fixed safety and precedence contract still applies.";
}

function renderProviders() {
  const host = el("provider-cards");
  clear(host);

  for (const p of base.editable.providers) {
    const card = add(host, "article", "prov");
    const head = add(card, "div", "prov__head");
    add(head, "h3", "prov__name", p.id);
    add(head, "span", "prov__api", p.api || "—");

    const meta = add(card, "dl", "readout readout--tight");
    const row = (dt, dd, chip) => {
      const r = add(meta, "div", "readout__row");
      add(r, "dt", null, dt);
      const d = add(r, "dd", null, chip ? null : dd);
      if (chip) {
        add(d, "code", "envname", dd);
        add(d, "span", `chip ${chip.on ? "chip--read" : "chip--off"}`, chip.text);
      }
      return r;
    };
    row("Endpoint", p.baseUrl || "—");
    if (p.apiKeyEnv) {
      // Which file holds it matters: this station lifts its model key out of a
      // different env file than the gateway's own, and saying "not set" when it
      // is simply somewhere else would be a lie the operator has to debug.
      const r = row("Credential", p.apiKeyEnv, {
        on: p.apiKeyPresent === true,
        text: p.apiKeyPresent === true ? "Set on the host" : "Not found",
      });
      add(
        r.querySelector("dd"),
        "span",
        "readout__aside",
        p.apiKeyIn ? `in ${p.apiKeyIn}` : "not in any env file this page reads",
      );
    } else {
      row("Credential", "none needed");
    }

    const table = add(card, "div", "tags");
    const th = add(table, "div", "tags__head");
    add(th, "span", null, "Model tag");
    add(th, "span", null, "Label");
    p.models.forEach((m, i) => {
      const rowEl = add(table, "div", "tags__row");
      const tagInput = document.createElement("input");
      tagInput.className = "input input--mono";
      tagInput.type = "text";
      tagInput.value = draft.tags[p.id][i].id;
      tagInput.spellcheck = false;
      tagInput.autocomplete = "off";
      tagInput.setAttribute("aria-label", `Model tag ${i + 1} for ${p.id}`);
      tagInput.disabled = !base.writable || !p.editable;
      tagInput.addEventListener("change", () => {
        const next = tagInput.value.trim();
        if (!next) {
          tagInput.value = draft.tags[p.id][i].id;
          return;
        }
        retarget(`${p.id}/${draft.tags[p.id][i].id}`, `${p.id}/${next}`);
        draft.tags[p.id][i].id = next;
        render();
      });
      rowEl.appendChild(tagInput);

      const nameInput = document.createElement("input");
      nameInput.className = "input";
      nameInput.type = "text";
      nameInput.value = draft.tags[p.id][i].name;
      nameInput.setAttribute("aria-label", `Label for model ${i + 1}`);
      nameInput.disabled = !base.writable || !p.editable;
      nameInput.addEventListener("change", () => {
        draft.tags[p.id][i].name = nameInput.value.trim();
        refreshSaveBar();
      });
      rowEl.appendChild(nameInput);

      const uses = [];
      const ref = `${p.id}/${draft.tags[p.id][i].id}`;
      if (draft.defaults.primary === ref) uses.push("main");
      if (draft.defaults.utilityModel === ref) uses.push("utility");
      if (draft.defaults.fallbacks.includes(ref)) uses.push("fallback");
      for (const [agentId, v] of Object.entries(draft.agents)) {
        if (v === ref) uses.push(agentId);
      }
      add(rowEl, "span", "tags__use", uses.length ? `in use · ${uses.join(", ")}` : "");
    });
    add(
      card,
      "p",
      "prov__foot",
      "Editing a tag re-points anything that used it. Context window and token caps are fixed here — change those in the config on the host.",
    );
  }

  el("env-path").textContent = (base.envPaths || ["~/.openclaw/.env"]).join(" or ");

  const cat = el("catalog");
  clear(cat);
  for (const entry of base.supported.known) {
    const item = add(cat, "div", `cat${entry.configured ? " cat--on" : ""}`);
    add(item, "span", "cat__name", entry.label);
    if (entry.env) {
      add(item, "code", "cat__env", entry.env);
    } else {
      add(item, "span", "cat__env cat__env--none", "no key needed");
    }
    const state = entry.configured
      ? { cls: "chip--read", text: "Configured" }
      : entry.envPresent
        ? { cls: "chip--draft", text: "Key present" }
        : entry.env === null
          ? // a local server needs no credential, so "not set up" would be a
            // misleading thing to say about it
            { cls: "chip--off", text: "Not configured" }
          : { cls: "chip--off", text: "No key set" };
    add(item, "span", `chip ${state.cls}`, state.text);
  }
  el("catalog-foot").textContent = base.supported.grounded
    ? `${base.supported.total} providers are supported by the OpenClaw installed on this host; the ${base.supported.known.length} above are the ones ORDERLY names a variable for.`
    : "Read from ORDERLY's own table — this host's OpenClaw docs weren't readable, so the full supported list couldn't be confirmed.";
}

function renderDuty() {
  const d = base.duty;

  const ruling = el("duty-ruling");
  clear(ruling);
  const rrow = (dt, dd, chip) => {
    const r = add(ruling, "div", "readout__row");
    add(r, "dt", null, dt);
    const cell = add(r, "dd", null, chip ? null : dd);
    if (chip) {
      add(cell, "span", `chip ${chip.cls}`, chip.text);
      if (dd) add(cell, "span", "readout__aside", dd);
    }
  };
  rrow("Sandbox", `${d.sandbox.backend || "—"} · every session`, {
    cls: d.sandbox.mode === "all" ? "chip--read" : "chip--off",
    text: d.sandbox.mode === "all" ? "All sandboxed" : `mode: ${d.sandbox.mode}`,
  });
  rrow("Elevated tools", d.sandbox.elevated ? "a host escape exists" : "no host escape", {
    cls: d.sandbox.elevated ? "chip--off" : "chip--read",
    text: d.sandbox.elevated ? "ON" : "Off",
  });
  rrow("Denied everywhere", d.sandbox.globalDeny.join(", ") || "nothing");
  rrow("Also allowed", d.sandbox.globalAlsoAllow.join(", ") || "nothing");
  rrow("Config reload", `${d.reload} — the gateway applies edits itself`);

  const agents = el("duty-agents");
  clear(agents);
  for (const a of d.agents) {
    const rowEl = add(agents, "article", "arow");
    const head = add(rowEl, "div", "arow__head");
    add(head, "span", "arow__name", a.id);
    add(
      head,
      "span",
      `chip ${a.sandboxMode === "all" ? "chip--read" : "chip--off"}`,
      a.sandboxMode === "all" ? "Sandboxed" : "Not sandboxed",
    );
    add(head, "span", "arow__net", `network: ${a.network}`);
    const facts = add(rowEl, "dl", "readout readout--tight");
    const arow = (dt, dd) => {
      const r = add(facts, "div", "readout__row");
      add(r, "dt", null, dt);
      add(r, "dd", null, dd);
    };
    arow("Model", a.model ? labelFor(a.model) : "the station default");
    arow("Tool profile", a.profile || "—");
    if (a.alsoAllow.length) arow("Also allowed", a.alsoAllow.join(", "));
    if (a.deny.length) arow("Denied", a.deny.join(", "));
    if (a.subagents.length) arow("May delegate to", a.subagents.join(", "));
    if (a.disabledCommands.length) {
      arow("Switched off in its container", a.disabledCommands.join(", "));
    }
  }

  const doors = el("duty-doors");
  clear(doors);
  const drow = (dt, on, text) => {
    const r = add(doors, "div", "readout__row");
    add(r, "dt", null, dt);
    const cell = add(r, "dd", null, null);
    add(cell, "span", `chip ${on ? "chip--read" : "chip--off"}`, on ? "On" : "Off");
    if (text) add(cell, "span", "readout__aside", text);
  };
  drow("Bind", true, `${d.endpoints.bind || "—"} · port ${d.endpoints.port ?? "—"}`);
  drow("Chat completions", d.endpoints.chatCompletions, "what this front door proxies");
  drow("Responses API", d.endpoints.responses, null);
  drow("Control UI", d.endpoints.controlUi, d.endpoints.controlUiPath || null);
  drow("Browser tool", d.endpoints.browser, null);
  const authRow = add(doors, "div", "readout__row");
  add(authRow, "dt", null, "Gateway auth");
  const authCell = add(authRow, "dd", null, null);
  add(authCell, "span", null, `${d.endpoints.authMode || "—"} · `);
  add(authCell, "code", "envname", d.endpoints.authEnv || "—");
  if (d.endpoints.gatewayDeny.length) {
    const r = add(doors, "div", "readout__row");
    add(r, "dt", null, "Gateway denies");
    add(r, "dd", null, d.endpoints.gatewayDeny.join(", "));
  }

  const channels = el("duty-channels");
  clear(channels);
  for (const c of d.channels) {
    const r = add(channels, "div", "readout__row");
    add(r, "dt", null, c.id);
    const cell = add(r, "dd", null, null);
    add(cell, "span", `chip ${c.enabled ? "chip--read" : "chip--off"}`, c.enabled ? "On" : "Off");
    add(
      cell,
      "span",
      "readout__aside",
      `${c.dmPolicy || "—"} · ${c.allowFrom} allowed${c.allowFrom === 1 ? "" : ""}`,
    );
    if (c.tokenEnv) add(cell, "code", "envname", c.tokenEnv);
  }
  for (const b of d.bindings) {
    const r = add(channels, "div", "readout__row");
    add(r, "dt", null, `${b.channel} routes to`);
    add(r, "dd", null, b.agentId || "—");
  }
}

function render() {
  renderAppearance();
  renderModels();
  renderReplyStyle();
  renderProviders();
  renderDuty();
  refreshSaveBar();
}

// --- saving ----------------------------------------------------------------

const dialog = el("confirm");

function openConfirm() {
  const { changes, edits } = diff();
  if (!changes.length) return;
  const list = el("confirm-list");
  clear(list);
  for (const c of changes) {
    const li = add(list, "li", "confirm__item");
    add(li, "span", "confirm__what", c.what);
    const move = add(li, "span", "confirm__move");
    add(move, "span", "confirm__from", c.from);
    add(move, "span", "confirm__arrow", "→");
    add(move, "span", "confirm__to", c.to);
  }
  el("progress").hidden = true;
  const styleOnly = Object.keys(edits).length === 1 && edits.replyStyle !== undefined;
  el("confirm-restart-note").hidden = styleOnly;
  el("do-save").disabled = false;
  el("do-save").textContent = styleOnly ? "Save reply style" : "Save and restart";
  dialog.showModal();
}

function progress(line, pct) {
  el("progress").hidden = false;
  el("progress-line").textContent = line;
  el("progress-bar").style.width = `${Math.min(100, Math.max(0, pct))}%`;
}

async function health() {
  try {
    const res = await fetch("/api/settings/health", { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function save() {
  const { edits } = diff();
  el("do-save").disabled = true;
  progress("Backing up and writing the config…", 8);

  let result;
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(edits),
    });
    result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result?.error || `The station answered ${res.status}.`);
  } catch (err) {
    progress(String(err?.message || "The change couldn't be saved."), 100);
    el("progress-bar").classList.add("is-bad");
    el("do-save").disabled = false;
    el("do-save").textContent = "Try again";
    return;
  }

  if (result.reloadRequired === false) {
    progress("Saved. New replies will use the updated style.", 100);
    await sleep(500);
    dialog.close();
    await load();
    flash("Reply style saved · no gateway restart needed");
    return;
  }

  // The gateway watches its own config: it either hot-reloads or restarts, and
  // systemd holds it up either way. So this waits on evidence rather than
  // announcing an outcome — and reports which of the two actually happened.
  const startedUptime = (await health())?.service?.uptimeSeconds ?? null;
  let dropped = false;
  let restarted = false;
  let good = 0;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await sleep(1000);
    const h = await health();
    const elapsed = 60000 - (deadline - Date.now());
    if (!h || !h.gateway?.reachable) {
      dropped = true;
      good = 0;
      progress("He's off his post — waiting for the gateway to come back…", 20 + elapsed / 900);
    } else {
      const up = h.service?.uptimeSeconds;
      if (startedUptime !== null && Number.isFinite(up) && up < startedUptime) restarted = true;
      good += 1;
      progress(
        dropped || restarted ? "Back up — checking he's steady…" : "Applying…",
        50 + good * 12,
      );
      if (good >= 3) {
        progress(
          dropped || restarted
            ? "Saved. He's back at his post."
            : "Saved. The gateway applied it without needing a restart.",
          100,
        );
        await sleep(700);
        dialog.close();
        await load();
        flash(result.backup ? `Saved · backed up as ${result.backup}` : "Saved");
        return;
      }
    }
  }
  progress(
    "Saved, but the gateway hasn't answered in a minute. The old config is backed up beside it on the host.",
    100,
  );
  el("progress-bar").classList.add("is-bad");
  el("do-save").disabled = false;
  el("do-save").textContent = "Close";
  el("do-save").onclick = () => dialog.close();
}

function flash(text) {
  const state = el("head-state");
  state.dataset.state = "saved";
  state.textContent = text;
}

// --- loading ---------------------------------------------------------------

async function load() {
  const state = el("head-state");
  try {
    const res = await fetch("/api/settings", { cache: "no-store" });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload?.error || `The station answered ${res.status}.`);
    base = payload;
    draft = makeDraft(payload);
    render();
    state.dataset.state = base.writable ? "ok" : "warn";
    state.textContent = base.writable
      ? `${base.editable.providers.length} provider configured · ${base.duty.agents.length} agents · gateway ${base.gateway?.reachable ? "answering" : "not answering"}`
      : base.readOnlyReason || "Read-only: this page can show the config but not change it.";
  } catch (err) {
    state.dataset.state = "bad";
    state.textContent = String(err?.message || "The settings service couldn't be reached.");
  }
}

// --- wiring ----------------------------------------------------------------

for (const opt of document.querySelectorAll(".panelnav__opt")) {
  opt.addEventListener("click", () => {
    for (const other of document.querySelectorAll(".panelnav__opt")) {
      other.classList.toggle("is-on", other === opt);
    }
    for (const panel of document.querySelectorAll(".panel")) {
      panel.classList.toggle("is-on", panel.id === `panel-${opt.dataset.panel}`);
    }
    // Panels differ a lot in length. Without this, switching from a long one
    // while scrolled down lands the operator below the shorter one's content,
    // on an empty screen.
    const top = el("panels").getBoundingClientRect().top + window.scrollY - 90;
    window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  });
}

el("review").addEventListener("click", openConfirm);
el("do-save").addEventListener("click", save);
el("discard").addEventListener("click", () => {
  draft = makeDraft(base);
  render();
});

el("bar-where").textContent =
  location.hostname === "127.0.0.1" || location.hostname === "localhost"
    ? "Private station · tunnel"
    : "Private station · tailnet";

renderAppearance();
load();
