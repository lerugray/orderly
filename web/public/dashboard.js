const el = (id) => document.getElementById(id);
const node = (tag, className, text) => {
  const out = document.createElement(tag);
  if (className) out.className = className;
  if (text !== undefined) out.textContent = text;
  return out;
};

let snapshot = null;
let polling = false;

function number(value, fallback = "—") {
  return Number.isFinite(value) ? new Intl.NumberFormat().format(value) : fallback;
}

function stamp(value) {
  const date = new Date(value ?? "");
  return Number.isNaN(date.valueOf()) ? "—" : date.toLocaleString();
}

function duration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function countdown(value) {
  const time = Date.parse(value ?? "");
  if (!Number.isFinite(time)) return "Reset unknown";
  const seconds = Math.ceil((time - Date.now()) / 1000);
  if (seconds <= 0) return `Reset due · ${stamp(value)}`;
  return `Resets in ${duration(seconds)} · ${stamp(value)}`;
}

function summaryCard(label, value, detail) {
  const card = node("article", "summary-card");
  card.append(
    node("p", "summary-card__label", label),
    node("p", "summary-card__value", value),
    node("p", "summary-card__detail", detail),
  );
  return card;
}

function renderAttention(items) {
  const root = el("attention");
  root.replaceChildren();
  if (!items.length) {
    const clear = node("div", "attention__clear");
    clear.append(node("span", "attention__dot"), node("span", null, "Nothing in the current snapshot needs attention."));
    root.append(clear);
    return;
  }
  const allowedLinks = new Set(["/", "/dashboard", "/orchestration", "/#queue"]);
  for (const item of items) {
    const card = node("article", "attention__item");
    const copy = node("div", "attention__copy");
    copy.append(node("strong", null, item?.label || "Attention"), node("small", null, item?.detail || ""));
    card.append(node("span", "attention__dot"), copy);
    if (allowedLinks.has(item?.href)) {
      const link = node("a", null, "Open");
      link.href = item.href;
      card.append(link);
    }
    root.append(card);
  }
}

function renderStation(station) {
  const root = el("station-summary");
  const gateway = station?.gateway?.reachable ? "Answering" : "Offline";
  const service = station?.service?.active ? "Active" : "Inactive";
  const channelNames = (station?.channels || []).map((channel) => channel.id).join(", ") || "None enabled";
  root.replaceChildren(
    summaryCard("Gateway", gateway, station?.gateway?.latency_ms === null ? "Latency unavailable" : `${number(station?.gateway?.latency_ms)}ms probe`),
    summaryCard("Service", service, station?.service?.uptime_seconds === null ? "Uptime unavailable" : `${duration(station.service.uptime_seconds)} uptime`),
    summaryCard("Agents", number(station?.agents?.configured), `${number(station?.agents?.sandboxed)} sandboxed`),
    summaryCard("Default model", station?.default_model || "Not reported", station?.chat_available ? "Web chat available" : "Web chat unavailable"),
    summaryCard("Channels", number(station?.channels?.length), channelNames),
    summaryCard("Checked", stamp(station?.checked_at), "Live station probe"),
  );
}

function renderSubscriptions(rows) {
  const root = el("subscriptions");
  root.replaceChildren();
  if (!rows.length) {
    root.append(node("div", "empty-card", "No subscription meters enabled."));
    return;
  }
  for (const row of rows) {
    const card = node("article", "subscription");
    const head = node("header", "subscription__head");
    const title = node("h3", null, row.label || row.id || "Subscription");
    const state = node("span", "state-chip", row.state || "unavailable");
    state.dataset.state = row.state || "unavailable";
    head.append(title, state);
    card.append(head, node("p", "subscription__detail", row.detail || "Quota snapshot unavailable"));
    const windows = node("div", "subscription__windows");
    for (const window of row.windows || []) {
      const wrap = node("div", "subscription__window");
      const windowHead = node("div", "subscription__window-head");
      const remaining = Number.isFinite(window.remaining_pct) ? `${window.remaining_pct}% remaining` : "Remaining unknown";
      windowHead.append(node("strong", null, window.kind || "window"), node("span", null, remaining));
      const meter = node("div", "meter");
      meter.setAttribute("role", "meter");
      meter.setAttribute("aria-label", `${window.kind || "Quota"} remaining`);
      meter.setAttribute("aria-valuemin", "0");
      meter.setAttribute("aria-valuemax", "100");
      if (Number.isFinite(window.remaining_pct)) meter.setAttribute("aria-valuenow", String(window.remaining_pct));
      const fill = node("span", "meter__fill");
      fill.style.width = `${Number.isFinite(window.remaining_pct) ? Math.max(0, Math.min(100, window.remaining_pct)) : 0}%`;
      meter.append(fill);
      const reset = node("p", "subscription__reset", countdown(window.resets_at));
      reset.dataset.resetAt = window.resets_at || "";
      wrap.append(windowHead, meter, reset);
      windows.append(wrap);
    }
    card.append(windows);
    card.append(
      node("p", "subscription__seats", `Seats · ${(row.seat_refs || []).join(", ") || "No ORDERLY seat references"}`),
      node("p", "subscription__meta", `${row.source || "unknown source"} · observed ${stamp(row.observed_at)}`),
    );
    root.append(card);
  }
}

function renderLanes(lanes) {
  const counts = lanes?.counts || {};
  const states = counts.states || {};
  el("lane-summary").replaceChildren(
    summaryCard("Active", number(counts.active), `running ${number(states.running, "0")} · dispatched ${number(states.dispatched, "0")}`),
    summaryCard("Queued", number(counts.queued), `proposed ${number(states.proposed, "0")}`),
    summaryCard("Terminal", number(counts.terminal), "ready for inspection"),
    summaryCard("Terminal classes", number(Object.keys(counts.terminal_classes || {}).length), Object.entries(counts.terminal_classes || {}).map(([key, value]) => `${key} ${value}`).join(" · ") || "None"),
  );
  const focus = el("lane-focus");
  focus.replaceChildren();
  const active = lanes?.active?.[0];
  const latestTerminal = (lanes?.recent || []).find((lane) => lane.state === "terminal");
  if (!active && !latestTerminal) {
    focus.append(node("p", null, "No active or terminal lanes are registered."));
    return;
  }
  const chosen = active || latestTerminal;
  const head = node("div", "lane-focus__head");
  head.append(node("h3", null, active ? "Active lane" : "Most recent terminal lane"), node("span", "state-chip", chosen.state));
  const facts = node("p", "lane-focus__facts");
  if (active) {
    facts.textContent = `${chosen.repo_id || "unknown repo"} · ${chosen.preset_id || "unknown preset"} · started ${stamp(chosen.dispatched_ts || chosen.created_ts)} · timeout ${duration(chosen.timeout_s)} · elapsed ${duration(chosen.elapsed_s)}`;
  } else {
    facts.textContent = `${chosen.repo_id || "unknown repo"} · ${chosen.terminal_class || "unclassified"} · terminal ${stamp(chosen.terminal_ts)} · READY FOR OPERATOR INSPECTION`;
  }
  focus.append(head, facts);
}

function timelineEvents(lanes) {
  const events = [];
  for (const lane of lanes || []) {
    if (lane.created_ts) events.push({ at: lane.created_ts, event: "Created", lane });
    if (lane.dispatched_ts) events.push({ at: lane.dispatched_ts, event: "Dispatched", lane });
    if (lane.terminal_ts) events.push({ at: lane.terminal_ts, event: `Terminal · ${lane.terminal_class || "unclassified"}`, lane });
  }
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 16);
}

function renderTimeline(lanes) {
  const root = el("timeline");
  root.replaceChildren();
  const events = timelineEvents(lanes?.recent);
  if (!events.length) {
    root.append(node("div", "timeline__row", "No broker activity recorded."));
    return;
  }
  for (const item of events) {
    const row = node("div", "timeline__row");
    const copy = node("div", "timeline__copy");
    copy.append(node("strong", null, item.event), node("small", null, `${item.lane.repo_id || "unknown repo"} · ${item.lane.preset_id || "unknown preset"}`));
    row.append(copy, node("time", "timeline__time", stamp(item.at)));
    root.append(row);
  }
}

function renderOrders(orders) {
  const root = el("orders");
  root.replaceChildren();
  const counts = orders?.counts || {};
  const rows = [
    ["Approval source", orders?.available ? "Available" : "Unavailable"],
    ["Coding lanes waiting", snapshot?.lanes?.counts?.queued],
    ["Approvals pending", counts.pending],
    ["Calendar proposals", counts.events],
    ["Approved", counts.approved],
    ["Discarded", counts.discarded],
    ["Calendar write", orders?.calendar_write ? "Configured" : "Not configured"],
  ];
  for (const [label, value] of rows) {
    const row = node("div", "order-row");
    row.append(node("span", null, label), node("strong", null, Number.isFinite(value) ? number(value) : value));
    root.append(row);
  }
}

function draw(payload) {
  snapshot = payload;
  renderAttention(Array.isArray(payload?.attention) ? payload.attention : []);
  renderStation(payload?.station || {});
  renderSubscriptions(Array.isArray(payload?.subscriptions) ? payload.subscriptions : []);
  renderLanes(payload?.lanes || {});
  renderTimeline(payload?.lanes || {});
  renderOrders(payload?.orders || {});
  el("snapshot-stamp").textContent = `Snapshot ${stamp(payload?.observed_at)}`;
}

async function request(path, method = "GET") {
  const response = await fetch(path, {
    method,
    headers: { Accept: "application/json", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || `The station answered ${response.status}.`);
  return payload;
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    draw(await request("/api/dashboard"));
  } catch (error) {
    el("snapshot-stamp").textContent = error.message;
  } finally {
    polling = false;
  }
}

el("refresh-quota").addEventListener("click", async () => {
  const button = el("refresh-quota");
  button.disabled = true;
  el("snapshot-stamp").textContent = "Refreshing the bounded quota snapshot…";
  try {
    draw(await request("/api/dashboard/refresh", "POST"));
  } catch (error) {
    el("snapshot-stamp").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

setInterval(() => {
  for (const reset of document.querySelectorAll("[data-reset-at]")) {
    reset.textContent = countdown(reset.dataset.resetAt);
  }
}, 30_000);
setInterval(poll, 15_000);
void poll();
