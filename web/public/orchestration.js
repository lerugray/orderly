import { digestJson, optionRecords, proposalPrefill } from "./orchestration-core.js";

const el = (id) => document.getElementById(id);
const form = el("dispatch-form");
const repoSelect = el("repo-id");
const presetSelect = el("preset-id");
const tokenInput = el("operator-token");
const proposeButton = el("propose-button");
const confirmButton = el("confirm-button");
const review = el("review");
const lanesNode = el("lanes");
const consultForm = el("consult-form");
const consultButton = el("consult-button");
const seatProposal = el("seat-proposal");
const prefillButton = el("prefill-dispatch");

let operatorToken = "";
let currentProposal = null;
let currentSeatPrefill = null;
let currentAllowlist = { repos: [], presets: [] };
let brokerOnline = false;
let optionsReady = false;
let polling = false;
let pollTimer = null;

function node(tag, className, text) {
  const out = document.createElement(tag);
  if (className) out.className = className;
  if (text !== undefined) out.textContent = text;
  return out;
}

function display(value, fallback = "—") {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function shortSha(value) {
  return typeof value === "string" && value ? value.slice(0, 12) : "—";
}

function stamp(value) {
  if (typeof value !== "string" || !value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function setBrokerState(online) {
  brokerOnline = online;
  const state = el("broker-state");
  state.dataset.state = online ? "online" : "offline";
  state.textContent = online ? "Broker online" : "Broker offline · read-only page";
  proposeButton.disabled = !online || !optionsReady;
  consultButton.disabled = !online;
}

function fillSelect(select, records, placeholder) {
  select.replaceChildren();
  const first = node("option", null, records.length ? placeholder : "None available");
  first.value = "";
  select.append(first);
  for (const record of records) {
    const option = node("option", null, record.label);
    option.value = record.id;
    select.append(option);
  }
  select.disabled = records.length === 0;
}

async function jsonRequest(path, { method = "GET", body, token } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["X-Orderly-Operator"] = token;
  const response = await fetch(path, {
    method,
    headers,
    cache: "no-store",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error || `The station answered ${response.status}.`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function loadOptions() {
  try {
    const payload = await jsonRequest("/api/orchestration/v1/allowlist");
    const repos = optionRecords(payload?.repos, "repo_id");
    const presets = optionRecords(payload?.presets, "preset_id");
    currentAllowlist = {
      repos: Array.isArray(payload?.repos) ? payload.repos : [],
      presets: Array.isArray(payload?.presets) ? payload.presets : [],
    };
    fillSelect(repoSelect, repos, "Choose a repository");
    fillSelect(presetSelect, presets, "Choose a preset");
    optionsReady = repos.length > 0 && presets.length > 0;
    setBrokerState(true);
    if (!optionsReady) {
      el("dispatch-message").textContent = "The broker returned no dispatchable repositories or presets.";
    }
  } catch (error) {
    optionsReady = false;
    currentAllowlist = { repos: [], presets: [] };
    fillSelect(repoSelect, [], "None available");
    fillSelect(presetSelect, [], "None available");
    if (error.status === 503) setBrokerState(false);
    el("dispatch-message").textContent = error.message;
  }
}

function fact(list, name, value) {
  const wrap = node("div");
  wrap.append(node("dt", null, name), node("dd", null, display(value)));
  list.append(wrap);
}

function renderLane(lane) {
  const terminal = lane?.state === "terminal";
  const card = node("article", terminal ? "lane lane--terminal" : "lane");

  const head = node("header", "lane__head");
  head.append(node("h3", "lane__id", display(lane?.id, "Unnamed lane")));
  head.append(node("span", "lane__state", display(lane?.state, "unknown state")));
  card.append(head);

  const body = node("div", "lane__body");
  if (terminal) body.append(node("p", "inspection-label", "READY FOR OPERATOR INSPECTION"));

  const facts = node("dl", "lane__facts");
  fact(facts, "Repository", lane?.repo_id);
  fact(facts, "Preset", lane?.preset_id);
  fact(facts, "Base", shortSha(lane?.base_sha));
  fact(facts, "Brief SHA-256", lane?.brief_sha256);
  fact(facts, "Timeout", Number.isFinite(lane?.timeout_s) ? `${lane.timeout_s}s` : lane?.timeout_s);
  fact(facts, "Created", stamp(lane?.created_ts));
  fact(facts, "Dispatched", stamp(lane?.dispatched_ts));
  fact(facts, "Terminal", stamp(lane?.terminal_ts));
  fact(facts, "Terminal class", terminal ? lane?.terminal_class : null);
  body.append(facts);

  const details = node("div", "lane__details");
  const record = node("section");
  record.append(node("h4", "lane__section-title", "Broker record"));
  record.append(node("pre", "lane__record", display(lane?.terminal_record)));
  details.append(record);

  const diff = node("section");
  diff.append(node("h4", "lane__section-title", "Diffstat"));
  diff.append(node("pre", "lane__record", display(lane?.harvest?.diffstat)));
  details.append(diff);

  const log = node("section");
  log.append(node("h4", "lane__section-title worker-label", "WORKER CLAIMS · UNVERIFIED"));
  log.append(node("pre", "lane__log", display(lane?.log_excerpt, "No bounded excerpt.")));
  details.append(log);

  const inventory = node("section");
  inventory.append(node("h4", "lane__section-title", "Untracked inventory"));
  inventory.append(node("pre", "lane__record", display(lane?.harvest?.untracked_inventory, "None reported.")));
  details.append(inventory);
  body.append(details);

  if (!terminal && (lane?.state === "dispatched" || lane?.state === "running")) {
    const actions = node("div", "lane__actions");
    const cancel = node("button", "ghost lane__cancel", "Cancel lane");
    cancel.type = "button";
    cancel.addEventListener("click", () => cancelLane(lane));
    actions.append(cancel);
    body.append(actions);
  }

  card.append(body);
  return card;
}

function drawLanes(records) {
  lanesNode.replaceChildren();
  if (!records.length) {
    lanesNode.append(node("div", "offline-card", "No lanes are registered."));
    return;
  }
  for (const lane of records) lanesNode.append(renderLane(lane));
}

async function loadLanes() {
  try {
    const payload = await jsonRequest("/api/orchestration/v1/lanes");
    const records = Array.isArray(payload) ? payload : Array.isArray(payload?.lanes) ? payload.lanes : [];
    setBrokerState(true);
    drawLanes(records);
    el("board-note").textContent = records.some((lane) => lane?.state !== "terminal")
      ? "A lane is active. This board refreshes every five seconds."
      : "Broker-owned state. Terminal work remains here for operator inspection."
    el("board-stamp").textContent = `read ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
    return records.some((lane) => lane?.state !== "terminal");
  } catch (error) {
    if (error.status === 503) setBrokerState(false);
    lanesNode.replaceChildren(node("div", "offline-card", "The broker is offline. The desk still renders, but lane state and dispatch controls are unavailable."));
    el("board-note").textContent = error.message;
    el("board-stamp").textContent = "broker unavailable";
    return false;
  }
}

async function pollBoard() {
  if (polling) return;
  polling = true;
  const active = await loadLanes();
  polling = false;
  clearTimeout(pollTimer);
  pollTimer = setTimeout(pollBoard, active ? 5000 : 20000);
}

async function cancelLane(lane) {
  if (!operatorToken) {
    el("dispatch-message").textContent = "Enter the operator token before cancelling a lane.";
    tokenInput.focus();
    return;
  }
  const laneName = display(lane?.id, "unnamed lane");
  if (!window.confirm(`Cancel lane ${laneName}?\n\nThe broker will TERM→KILL this lane's process group.`)) return;
  try {
    await jsonRequest(`/api/orchestration/v1/lanes/${encodeURIComponent(lane.id)}/cancel`, {
      method: "POST",
      token: operatorToken,
    });
    el("dispatch-message").textContent = `Cancellation requested for ${laneName}.`;
    await loadLanes();
  } catch (error) {
    el("dispatch-message").textContent = error.message;
  }
}

tokenInput.addEventListener("input", () => {
  operatorToken = tokenInput.value;
});

consultForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!operatorToken) {
    el("consult-message").textContent = "Enter the operator token before asking ORDERLY.";
    tokenInput.focus();
    return;
  }
  consultButton.disabled = true;
  currentSeatPrefill = null;
  prefillButton.hidden = true;
  seatProposal.hidden = true;
  el("consult-message").textContent = "Consulting the qualified episodic seat…";
  try {
    const result = await jsonRequest("/api/orchestration/v1/seat/consult", {
      method: "POST",
      token: operatorToken,
      body: { ask: el("seat-ask").value },
    });
    if (result?.seat_failure || !result?.proposal || typeof result.proposal !== "object") {
      throw Object.assign(new Error("Seat unavailable, fail closed."), { seatFailure: true });
    }
    el("seat-proposal-json").textContent = JSON.stringify(result.proposal, null, 2);
    currentSeatPrefill = proposalPrefill(result.proposal, currentAllowlist);
    prefillButton.hidden = !currentSeatPrefill;
    seatProposal.hidden = false;
    el("consult-message").textContent = currentSeatPrefill
      ? "Proposal only. You may prefill the four bounded dispatch fields."
      : "Proposal only. It does not contain a safe dispatch prefill.";
  } catch (error) {
    const failedSeat = error.seatFailure || error.payload?.seat_failure;
    el("consult-message").textContent = failedSeat
      ? "Seat unavailable, fail closed."
      : error.message;
  } finally {
    consultButton.disabled = !brokerOnline;
  }
});

prefillButton.addEventListener("click", () => {
  if (!currentSeatPrefill) return;
  repoSelect.value = currentSeatPrefill.repo_id;
  presetSelect.value = currentSeatPrefill.preset_id;
  el("brief-text").value = currentSeatPrefill.brief_text;
  el("timeout-s").value = String(currentSeatPrefill.timeout_s);
  currentProposal = null;
  el("action-digest").textContent = "";
  review.hidden = true;
  el("dispatch-message").textContent = "Four proposal fields prefilled. Request and review a new broker digest; nothing has run.";
  form.scrollIntoView({ behavior: "smooth", block: "start" });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!operatorToken) {
    el("dispatch-message").textContent = "Enter the operator token to request a proposal.";
    tokenInput.focus();
    return;
  }
  proposeButton.disabled = true;
  el("dispatch-message").textContent = "Asking the broker to resolve the action digest…";
  try {
    const proposal = await jsonRequest("/api/orchestration/v1/dispatch/propose", {
      method: "POST",
      token: operatorToken,
      body: {
        repo_id: repoSelect.value,
        preset_id: presetSelect.value,
        brief_text: el("brief-text").value,
        timeout_s: Number(el("timeout-s").value),
      },
    });
    if (typeof proposal?.proposal_id !== "string" || !proposal?.digest) {
      throw new Error("The broker returned an incomplete proposal.");
    }
    currentProposal = proposal;
    el("action-digest").textContent = digestJson(proposal);
    review.hidden = false;
    review.scrollIntoView({ behavior: "smooth", block: "nearest" });
    el("dispatch-message").textContent = "Proposal only. Review the digest before confirming.";
  } catch (error) {
    el("dispatch-message").textContent = error.message;
  } finally {
    proposeButton.disabled = !brokerOnline || !optionsReady;
  }
});

confirmButton.addEventListener("click", async () => {
  if (!currentProposal) return;
  if (!operatorToken) {
    el("dispatch-message").textContent = "Enter the operator token to confirm this digest.";
    tokenInput.focus();
    return;
  }
  confirmButton.disabled = true;
  el("dispatch-message").textContent = "Confirming the reviewed digest…";
  try {
    const result = await jsonRequest("/api/orchestration/v1/dispatch/confirm", {
      method: "POST",
      token: operatorToken,
      body: {
        proposal_id: currentProposal.proposal_id,
        digest_ack: currentProposal.digest,
      },
    });
    el("dispatch-message").textContent = `Broker accepted lane ${display(result?.lane_id)}.`;
    currentProposal = null;
    review.hidden = true;
    form.reset();
    tokenInput.value = operatorToken;
    await loadLanes();
  } catch (error) {
    el("dispatch-message").textContent = error.message;
  } finally {
    confirmButton.disabled = false;
  }
});

el("discard-proposal").addEventListener("click", () => {
  currentProposal = null;
  el("action-digest").textContent = "";
  review.hidden = true;
  el("dispatch-message").textContent = "Proposal removed from this review surface; no lane was started.";
});

window.addEventListener("pagehide", () => {
  operatorToken = "";
  tokenInput.value = "";
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") pollBoard();
});

await loadOptions();
await pollBoard();
