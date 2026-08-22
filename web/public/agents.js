// ORDERLY — the agents roster.
//
// Spec §5.1's management surface: list, inspect, create, rename, describe,
// suspend, resume, retire. What it deliberately has no control for is the whole
// point — no credential field, no environment variable, no filesystem path, no
// image, no network setting, no shell. The server's typed envelope refuses those
// by name, so this page not drawing them is belt to that braces.
//
// Nothing here is built with innerHTML. Names and purposes are the operator's
// own text and are put on the page as text nodes.

const el = (id) => document.getElementById(id);

function add(parent, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  parent.appendChild(node);
  return node;
}

el("bar-where").textContent =
  location.hostname === "127.0.0.1" || location.hostname === "localhost"
    ? "Private station · tunnel"
    : "Private station · tailnet";

let roster = { system: [], agents: [], counts: { named: 0, active: 0, pending: 0 } };
let connectorState = { state: "ok", catalog: [], instances: [], attachments: [], agents: [] };
let busy = false;

function state(text, kind) {
  const line = el("head-state");
  line.textContent = text;
  line.dataset.state = kind;
}

function lifecycleChip(agent) {
  if (agent.agentClass === "system") return ["chip chip--read", "Station's own"];
  if (agent.lifecycle === "active") return ["chip chip--act", "On duty"];
  if (agent.lifecycle === "pending") return ["chip chip--draft", "Pending checks"];
  if (agent.lifecycle === "suspended") return ["chip chip--off", "Suspended"];
  return ["chip chip--off", "Retired"];
}

async function ask(body) {
  const res = await fetch("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) throw new Error(payload?.error || `The station answered ${res.status}.`);
  return payload;
}

async function askConnector(body) {
  const res = await fetch("/api/connectors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload?.error || `The connector control answered ${res.status}.`);
  return payload;
}

async function refresh() {
  try {
    const [agentsRes, connectorsRes] = await Promise.all([
      fetch("/api/agents", { headers: { Accept: "application/json" } }),
      fetch("/api/connectors", { headers: { Accept: "application/json" } }),
    ]);
    roster = await agentsRes.json();
    connectorState = await connectorsRes.json();
  } catch {
    state("The station didn't answer. Nothing was changed.", "error");
    return;
  }
  if (roster.state === "error") {
    state(roster.error || "The roster couldn't be read.", "error");
  } else {
    const named = roster.counts?.named ?? 0;
    state(
      named === 0
        ? "Three station identities, and none of your own yet."
        : `Three station identities and ${named === 1 ? "one you named" : `${named} you named`}${
            roster.counts.pending
              ? `, ${roster.counts.pending === 1 ? "one of which is" : `${roster.counts.pending} of which are`} still pending checks`
              : ""
          }.`,
      "ok",
    );
  }
  el("roster-when").textContent = `read ${new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
  draw();
  drawConnectors();
}

function draw() {
  const list = el("roster-list");
  list.textContent = "";
  for (const agent of [...(roster.system || []), ...(roster.agents || [])]) {
    drawRow(list, agent);
  }
}

function drawRow(list, agent) {
  const row = add(list, "li", "roster__row");
  if (agent.lifecycle === "retired") row.classList.add("roster__row--gone");

  const head = add(row, "div", "roster__head");
  add(head, "span", "roster__name", agent.name);
  add(head, "code", "roster__handle", `@${agent.handle}`);
  const [chipClass, chipText] = lifecycleChip(agent);
  add(head, "span", chipClass, chipText);

  add(row, "p", "roster__what", agent.description || "No purpose written down yet.");

  const facts = add(row, "p", "roster__facts");
  add(facts, "span", "roster__fact", agent.memoryPolicy === "persistent" ? "Remembers" : "Memoryless");
  add(facts, "span", "roster__fact", (agent.capabilities || []).length
    ? `Capabilities: ${agent.capabilities.join(", ")}`
    : "No capabilities");
  add(facts, "span", "roster__fact", (agent.delegation || []).length
    ? `Delegates to: ${agent.delegation.join(", ")}`
    : "No delegation");
  add(
    facts,
    "span",
    "roster__fact",
    `Container: ${agent.sandbox?.profile || "named-isolated"} · ${agent.sandbox?.state || "pending"}`,
  );

  if (agent.agentClass !== "system" && agent.sandbox?.verification) {
    drawProbe(row, agent.sandbox.verification);
  }

  if (agent.agentClass === "system") {
    add(row, "p", "roster__note", "The station's own identity. Its name, purpose and privileges are fixed here.");
    return;
  }

  const acts = add(row, "span", "roster__acts");

  if (agent.lifecycle === "pending") {
    act(acts, "Run its checks", async () => {
      await ask({ action: "activate", id: agent.id });
    });
  }
  if (agent.lifecycle === "active") {
    act(acts, "Suspend", () => ask({ action: "lifecycle", id: agent.id, lifecycle: "suspended" }));
  }
  if (agent.lifecycle === "suspended") {
    act(acts, "Resume and recheck", () => ask({ action: "activate", id: agent.id }));
  }
  if (agent.lifecycle !== "retired") {
    act(acts, "Rename", () => rename(agent));
    act(acts, "Rewrite its purpose", () => describe(agent));
    act(acts, "Retire", () => {
      const sure = window.confirm(
        `Retire ${agent.name}?\n\nIts thread stops. Its record, its transcript and its notes are kept, and "${agent.handle}" is reserved for good so the name can never land on someone else.`,
      );
      if (!sure) return null;
      return ask({ action: "lifecycle", id: agent.id, lifecycle: "retired" });
    });
  } else {
    act(acts, "Remove permanently", () => {
      const sure = window.confirm(
        `Remove ${agent.name} for good?\n\nThis deletes its record, its transcript and its notes from the station. It cannot be undone. The handle stays reserved.`,
      );
      if (!sure) return null;
      return ask({ action: "remove", id: agent.id });
    });
  }
}

function drawConnectors() {
  const host = el("connector-instances");
  host.textContent = "";
  el("connectors-when").textContent = `read ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  if (connectorState.state === "error") {
    add(host, "p", "field__warn", connectorState.error || "Connector state could not be read.");
  } else if (!(connectorState.instances || []).length) {
    add(host, "p", "roster__note", "No connector instance is installed. Reading this page created nothing.");
  }

  for (const instance of connectorState.instances || []) {
    const card = add(host, "article", "connector-card");
    const head = add(card, "div", "roster__head");
    add(head, "span", "roster__name", instance.label);
    add(head, "code", "roster__handle", instance.id);
    add(head, "span", `chip ${instance.lifecycle === "active" ? "chip--read" : "chip--off"}`, instance.lifecycle);
    add(card, "p", "roster__what", `${instance.accountLabel} · ${instance.kind}`);

    const existing = (connectorState.attachments || []).find(
      (attachment) => attachment.connectorId === instance.id && attachment.lifecycle !== "detached",
    );
    if (existing) {
      add(card, "p", "roster__facts", `Ruled to ${existing.agentId} · ${existing.lifecycle} · ${existing.operations.join(", ")}`);
      if (existing.lifecycle === "approved-pending-runtime") {
        add(card, "p", "roster__note", "Approved only. The socket is not active until the host mount and negative-access probes pass.");
      }
      const controls = add(card, "span", "roster__acts");
      const lifecycleAction = (label, action, warning) => act(controls, label, async () => {
        if (warning && !window.confirm(warning)) return null;
        return askConnector({ action, attachmentId: existing.id });
      });
      if (existing.lifecycle === "active") {
        lifecycleAction("Suspend", "suspend", `Suspend ${instance.label}?\n\nThe host controller removes and checks the socket route before recording it suspended.`);
      }
      if (existing.lifecycle === "suspended") {
        lifecycleAction("Resume", "resume", `Resume ${instance.label}?\n\nThe host controller restores the derived route and reruns every mount and negative-access probe first.`);
      }
      lifecycleAction("Detach", "detach", `Detach ${instance.label} from ${existing.agentId}?\n\nThe host controller removes and checks the runtime route before recording the attachment detached. The connector account itself is not revoked or deleted.`);
      continue;
    }
    if (instance.lifecycle !== "active") {
      add(card, "p", "roster__note", "Not attachable until its dedicated service and isolation probes pass.");
      continue;
    }

    const controls = add(card, "div", "connector-attach");
    const agentSelect = add(controls, "select", "select");
    for (const agent of (connectorState.agents || []).filter((item) => item.lifecycle === "active")) {
      const option = add(agentSelect, "option", null, `${agent.name} (${agent.id})`);
      option.value = agent.id;
    }
    const operations = add(controls, "div", "connector-ops");
    for (const operation of instance.operations.filter((item) => item.mode !== "apply")) {
      const label = add(operations, "label", "connector-op");
      const check = add(label, "input");
      check.type = "checkbox";
      check.value = operation.id;
      check.checked = operation.mode === "read";
      add(label, "span", null, `${operation.label} · ${operation.mode}`);
    }
    const button = add(controls, "button", "cta cta--solid", "Review attachment");
    button.type = "button";
    button.disabled = !(connectorState.agents || []).some((item) => item.lifecycle === "active");
    button.addEventListener("click", async () => {
      if (busy) return;
      const selected = [...operations.querySelectorAll("input:checked")].map((input) => input.value);
      if (!selected.length) return state("Choose at least one typed operation.", "error");
      busy = true;
      try {
        const proposal = await askConnector({
          action: "propose", connectorId: instance.id, agentId: agentSelect.value, operations: selected,
        });
        const summary = proposal.summary;
        const sure = window.confirm([
          `Attach ${summary.connector.label} to ${summary.agent.name}?`,
          "",
          `External account: ${summary.connector.accountLabel}`,
          `Operations: ${summary.operations.map((operation) => `${operation.label} [${operation.mode}]`).join(", ")}`,
          `Provider egress: ${summary.connector.egressHosts.join(", ")}`,
          summary.returnedData,
          "",
          summary.boundary,
          "",
          "Approval records the ruling only. It does not activate a socket mount.",
          `Digest: ${proposal.digest}`,
        ].join("\n"));
        if (!sure) return;
        const result = await askConnector({
          action: "confirm", connectorId: instance.id, agentId: agentSelect.value,
          operations: selected, confirmationDigest: proposal.digest,
        });
        state(result.note || "Connector ruling recorded.", "ok");
      } catch (error) {
        state(String(error?.message || "The connector ruling did not go through."), "error");
      } finally {
        busy = false;
        await refresh();
      }
    });
  }

  const catalog = el("connector-catalog");
  catalog.textContent = "";
  for (const kind of connectorState.catalog || []) {
    const row = add(catalog, "div", "cat");
    add(row, "span", "cat__name", kind.label);
    add(row, "span", "cat__env", kind.family);
    add(row, "span", `chip ${kind.maturity === "reserved" ? "chip--off" : "chip--read"}`,
      kind.maturity === "reserved" ? "Catalog only" : "Existing precedent");
  }
}

// §5.2 — the operator is shown what was actually checked, and what is still
// owed. A list of passed checks beside a list of ones that have not run is the
// honest shape; "active" on its own would be a claim.
function drawProbe(row, probe) {
  const panel = add(row, "div", "probe");
  const passed = (probe.checks || []).filter((check) => check.status === "passed").length;
  const heading = probe.status === "passed"
    ? "Container checks passed"
    : probe.status === "failed"
      ? "Container checks failed"
      : "Container checks pending";
  add(panel, "p", "probe__head", `${heading} · ${passed}/${(probe.checks || []).length}`);
  const ran = add(panel, "ul", "probe__list");
  for (const check of probe.checks || []) {
    const className = check.status === "passed" ? "probe__ok" : check.status === "failed" ? "probe__no" : "probe__owed";
    const item = add(ran, "li", className);
    add(item, "span", "probe__what", check.label);
    add(item, "span", "probe__detail", check.status);
  }
  if (probe.checkedAt) add(panel, "p", "roster__note", `Checked ${new Date(probe.checkedAt).toLocaleString()}`);
}

function act(parent, label, run) {
  const button = add(parent, "button", "ghost", label);
  button.type = "button";
  button.disabled = busy;
  button.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    draw();
    try {
      const outcome = await run();
      if (outcome !== null) state(`${label} — done.`, "ok");
    } catch (error) {
      state(String(error?.message || "That didn't go through."), "error");
    } finally {
      busy = false;
      await refresh();
    }
  });
  return button;
}

function rename(agent) {
  const name = window.prompt("What should it be called?", agent.name);
  if (name === null || name.trim() === agent.name) return null;
  const handle = window.prompt(
    `And how is it addressed? The old handle "${agent.handle}" stays reserved either way.`,
    agent.handle,
  );
  if (handle === null) return null;
  const fields = { action: "update", id: agent.id, name: name.trim() };
  if (handle.trim() && handle.trim() !== agent.handle) fields.handle = handle.trim();
  return ask(fields);
}

function describe(agent) {
  const description = window.prompt(
    "What is it for? This becomes its standing orders, which it can read and cannot change.",
    agent.description || "",
  );
  if (description === null) return null;
  return ask({ action: "update", id: agent.id, description: description.trim() });
}

// The handle follows the name until the operator touches it, and then stops —
// so a deliberate handle is never overwritten by a later edit to the name.
let handleTouched = false;
el("make-handle").addEventListener("input", () => {
  handleTouched = true;
});
el("make-name").addEventListener("input", () => {
  if (handleTouched) return;
  el("make-handle").value = el("make-name")
    .value.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 30);
});

el("make-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const name = el("make-name").value.trim();
  if (!name) return;
  const handle = el("make-handle").value.trim();
  const description = el("make-desc").value.trim();
  const memoryPolicy = el("make-memory").value;

  // §5.2's confirmation digest. It is a durable identity operation even with no
  // credential in sight, so it is confirmed — and the digest says what the thing
  // will and will not have, in the words the page uses everywhere else.
  const sure = window.confirm(
    [
      `Name a new agent "${name}"?`,
      "",
      `Addressed as: @${handle || "(from the name)"}`,
      `Memory: ${memoryPolicy === "persistent" ? "keeps its own notes and transcript" : "keeps nothing between conversations"}`,
      "Network: none",
      "Credentials: none",
      "Delegation: none",
      "Capabilities: none",
      "Writable storage: its own notes on this station, and nothing else",
      "Container: a separate named-isolated Docker sandbox",
      "",
      "It starts pending. Its checks run inside that live container, and it is not on duty until every one passes.",
    ].join("\n"),
  );
  if (!sure) return;

  busy = true;
  el("make-go").disabled = true;
  try {
    const made = await ask({
      action: "create",
      name,
      description,
      memoryPolicy,
      ...(handle ? { handle } : {}),
    });
    state(made.note || "Created.", "ok");
    el("make-form").reset();
    el("make-memory").value = "persistent";
    handleTouched = false;
  } catch (error) {
    state(String(error?.message || "That couldn't be created."), "error");
  } finally {
    busy = false;
    el("make-go").disabled = false;
    await refresh();
  }
});

refresh();
