// ORDERLY dashboard v1 — snapshot composition and the optional quota adapter.
//
// Quota is advisory and off by default. Explicitly configured subscriptions are
// reached through a pinned CodexBar v0.49.6 contract. Raw provider output,
// identities, credentials, commands and paths never cross the browser boundary.
//
// Two transports carry the same pinned contract:
//
//   codexbar-cli       execs the pinned CLI with fixed argv and a minimal
//                      environment. The desk process must itself be able to
//                      read the provider credentials, so this is only correct
//                      where desk and credential owner are the same user.
//
//   codexbar-loopback  reads `codexbar serve` over HTTP on a loopback address.
//                      The server runs as the credential-owning user; the desk
//                      holds no provider credential, no config file and no
//                      keychain access. GET /usage is unauthenticated on a
//                      loopback bind and returns the same document shape as
//                      `usage --format json`, so the same normalizer applies
//                      and the desk never needs a bearer token either. The
//                      endpoint is asserted to be loopback at construction,
//                      redirects are refused, and no Authorization header is
//                      ever sent — the desk cannot be talked off the machine.

import { constants } from "node:fs";
import { execFile as nodeExecFile } from "node:child_process";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export const DASHBOARD_VERSION = 1;
export const CODEXBAR_PINNED_VERSION = "0.49.6";
export const QUOTA_REFRESH_MS = 5 * 60 * 1000;
export const QUOTA_STALE_MS = 10 * 60 * 1000;
export const PROBE_TIMEOUT_MS = 30 * 1000;
// The loopback `codexbar serve` this desk may read. Loopback-only, by assertion.
export const DEFAULT_CODEXBAR_ENDPOINT = "http://127.0.0.1:18791";
// A usage document for one provider is small; anything larger is not our server.
export const MAX_LOOPBACK_BYTES = 256 * 1024;
export const QUOTA_SOURCES = Object.freeze(["codexbar-cli", "codexbar-loopback"]);
export const SUPPORTED_PROVIDERS = Object.freeze({
  codex: Object.freeze(["cli", "oauth", "api"]),
  claude: Object.freeze(["cli", "oauth"]),
  openai: Object.freeze(["api"]),
  copilot: Object.freeze(["api"]),
  gemini: Object.freeze(["api"]),
  kilo: Object.freeze(["cli", "api"]),
  openrouter: Object.freeze(["api"]),
  deepseek: Object.freeze(["api"]),
  moonshot: Object.freeze(["api"]),
  // Kimi Code (the coding subscription) is a distinct CodexBar provider from
  // moonshot, which is the Kimi Open Platform balance. Configuring a Kimi Code
  // subscription as `moonshot` reports the wrong account entirely.
  kimi: Object.freeze(["api", "cli"]),
  zai: Object.freeze(["api"]),
  ollama: Object.freeze(["api"]),
});

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ABSOLUTE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const WINDOW_NAMES = [
  ["primary", "session"],
  ["secondary", "weekly"],
  ["tertiary", "tertiary"],
];

export class DashboardConfigError extends Error {}
export class QuotaProbeError extends Error {}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  if (!isRecord(value)) throw new DashboardConfigError(`${label} must be an object`);
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new DashboardConfigError(`${label} has unknown field ${extras[0]}`);
}

export function validateDashboardConfig(raw) {
  exactKeys(raw, ["version", "subscriptions"], "dashboard config");
  if (raw.version !== 1 || !Array.isArray(raw.subscriptions)) {
    throw new DashboardConfigError("dashboard config must use version 1 with subscriptions");
  }
  const ids = new Set();
  const subscriptions = raw.subscriptions.map((item, index) => {
    exactKeys(
      item,
      ["id", "label", "provider", "source", "probe_source", "seat_refs", "headline_window", "account_index"],
      `subscription ${index + 1}`,
    );
    if (!ID.test(item.id ?? "") || ids.has(item.id)) {
      throw new DashboardConfigError(`subscription ${index + 1} has an invalid or duplicate id`);
    }
    if (typeof item.label !== "string" || !item.label.trim() || item.label.length > 80) {
      throw new DashboardConfigError(`subscription ${item.id} has an invalid label`);
    }
    if (!Object.hasOwn(SUPPORTED_PROVIDERS, item.provider) || !QUOTA_SOURCES.includes(item.source)) {
      throw new DashboardConfigError(`subscription ${item.id} is not a supported v1 source`);
    }
    // probe_source stays declared and validated for both transports so a config
    // reads the same either way. Over codexbar-loopback the strategy is chosen
    // by the serve host's own config, so the field documents intent rather than
    // selecting it — the desk has no argv to put it on.
    const localSources = SUPPORTED_PROVIDERS[item.provider];
    const probeSource = item.probe_source ?? (localSources.includes("cli") ? "cli" : localSources[0]);
    if (probeSource === "web" || probeSource === "auto" || !localSources.includes(probeSource)) {
      throw new DashboardConfigError(`subscription ${item.id} has an invalid probe_source`);
    }
    if (!Array.isArray(item.seat_refs) || item.seat_refs.some((ref) => typeof ref !== "string" || !ref || ref.length > 80)) {
      throw new DashboardConfigError(`subscription ${item.id} has invalid seat_refs`);
    }
    const headline = item.headline_window ?? "session";
    if (!new Set(["session", "weekly", "tertiary"]).has(headline)) {
      throw new DashboardConfigError(`subscription ${item.id} has an invalid headline_window`);
    }
    if (item.account_index !== undefined && (!Number.isInteger(item.account_index) || item.account_index < 1 || item.account_index > 99)) {
      throw new DashboardConfigError(`subscription ${item.id} has an invalid account_index`);
    }
    ids.add(item.id);
    return Object.freeze({
      id: item.id,
      label: item.label.trim(),
      provider: item.provider,
      source: item.source,
      probe_source: probeSource,
      seat_refs: [...item.seat_refs],
      headline_window: headline,
      ...(item.account_index === undefined ? {} : { account_index: item.account_index }),
    });
  });
  return Object.freeze({ version: 1, subscriptions: Object.freeze(subscriptions) });
}

export async function readDashboardConfig(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, subscriptions: [] };
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DashboardConfigError("dashboard config is not valid JSON");
  }
  return validateDashboardConfig(parsed);
}

function absoluteInstant(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !ABSOLUTE_ISO.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new QuotaProbeError("quota reset is not an absolute ISO instant");
  }
  return value;
}

function remainingFromUsed(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new QuotaProbeError("quota percentage is malformed");
  }
  return Math.max(0, Math.min(100, 100 - value));
}

function observedInstant(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string" || !ABSOLUTE_ISO.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new QuotaProbeError("quota observation time is malformed");
  }
  return value;
}

function detailFor(windows) {
  if (!windows.length) return "Quota windows unavailable";
  return windows
    .slice(0, 3)
    .map((window) =>
      window.remaining_pct === null
        ? `${window.kind} remaining unknown`
        : `${window.kind} ${window.remaining_pct}% remaining`,
    )
    .join("; ");
}

// Contract pinned to CodexBar v0.49.6 `usage --format json`: provider/source
// metadata and the primary/secondary/tertiary usage windows. Identity and every
// provider-specific extra are deliberately ignored.
export function normalizeCodexbarUsage(raw, subscription, nowMs = Date.now()) {
  if (!isRecord(raw) || raw.provider !== subscription.provider || !isRecord(raw.usage) || raw.error) {
    throw new QuotaProbeError("CodexBar usage schema mismatch");
  }
  const windows = [];
  for (const [field, kind] of WINDOW_NAMES) {
    const source = raw.usage[field];
    if (source === null || source === undefined) continue;
    if (!isRecord(source)) throw new QuotaProbeError("CodexBar quota window schema mismatch");
    windows.push({
      kind,
      remaining_pct: remainingFromUsed(source.usedPercent),
      resets_at: absoluteInstant(source.resetsAt),
    });
  }
  if (!windows.length) throw new QuotaProbeError("CodexBar returned no quota windows");
  const nowIso = new Date(nowMs).toISOString();
  const observedAt = observedInstant(raw.usage.updatedAt, nowIso);
  const headline = windows.find((window) => window.kind === subscription.headline_window) ?? null;
  return {
    id: subscription.id,
    label: subscription.label,
    provider: subscription.provider,
    seat_refs: [...subscription.seat_refs],
    state: "fresh",
    source: subscription.source,
    remaining_pct: headline?.remaining_pct ?? null,
    resets_at: headline?.resets_at ?? null,
    detail: detailFor(windows),
    windows,
    observed_at: observedAt,
    stale_at: new Date(Date.parse(observedAt) + QUOTA_STALE_MS).toISOString(),
  };
}

function unavailableRow(subscription, at) {
  return {
    id: subscription.id,
    label: subscription.label,
    provider: subscription.provider,
    seat_refs: [...subscription.seat_refs],
    state: "unavailable",
    source: subscription.source,
    remaining_pct: null,
    resets_at: null,
    detail: "Quota snapshot unavailable",
    windows: [],
    observed_at: at,
    stale_at: at,
  };
}

export function safeCachedRow(row, subscription, nowMs) {
  if (!isRecord(row) || row.id !== subscription.id || row.provider !== subscription.provider || row.source !== subscription.source) {
    return null;
  }
  try {
    const windows = Array.isArray(row.windows)
      ? row.windows.map((window) => {
          if (!isRecord(window) || typeof window.kind !== "string") throw new Error("bad window");
          const remaining = window.remaining_pct;
          if (remaining !== null && (typeof remaining !== "number" || !Number.isFinite(remaining))) throw new Error("bad pct");
          return {
            kind: window.kind.slice(0, 40),
            remaining_pct: remaining === null ? null : Math.max(0, Math.min(100, remaining)),
            resets_at: absoluteInstant(window.resets_at),
          };
        })
      : [];
    const observed = observedInstant(row.observed_at, new Date(nowMs).toISOString());
    const stale = observedInstant(row.stale_at, observed);
    const headline = windows.find((window) => window.kind === subscription.headline_window) ?? null;
    return {
      id: subscription.id,
      label: subscription.label,
      provider: subscription.provider,
      seat_refs: [...subscription.seat_refs],
      state:
        row.state === "unavailable" && windows.length === 0
          ? "unavailable"
          : row.state === "fresh" && nowMs <= Date.parse(stale)
            ? "fresh"
            : "stale",
      source: subscription.source,
      remaining_pct: headline?.remaining_pct ?? null,
      resets_at: headline?.resets_at ?? null,
      detail: detailFor(windows),
      windows,
      observed_at: observed,
      stale_at: stale,
    };
  } catch {
    return null;
  }
}

export async function atomicWriteDashboardCache(path, subscriptions) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(`${JSON.stringify({ version: 1, subscriptions }, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function readCache(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed?.version === 1 && Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [];
  } catch {
    return [];
  }
}

function execPromise(execFileImpl, command, args, options) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, options, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

function pinnedVersion(stdout) {
  const match = String(stdout).match(/(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/);
  return match?.[1] ?? null;
}

export function createCodexbarProbe({ execFileImpl = nodeExecFile, now = () => Date.now() } = {}) {
  return async function probe(subscription) {
    const environment = {
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME || "/nonexistent",
      LANG: process.env.LANG || "C.UTF-8",
      LC_ALL: process.env.LC_ALL || "C.UTF-8",
      NO_COLOR: "1",
      TERM: "dumb",
    };
    const options = {
      env: environment,
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    };
    const started = now();
    let version;
    try {
      version = pinnedVersion(await execPromise(execFileImpl, "codexbar", ["--version"], options));
    } catch {
      throw new QuotaProbeError("CodexBar is unavailable");
    }
    if (version !== CODEXBAR_PINNED_VERSION) throw new QuotaProbeError("CodexBar version mismatch");
    const remaining = Math.max(1, PROBE_TIMEOUT_MS - (now() - started));
    const args = ["usage", "--provider", subscription.provider, "--source", subscription.probe_source, "--format", "json", "--json-only"];
    if (subscription.account_index !== undefined) args.push("--account-index", String(subscription.account_index));
    let stdout;
    try {
      stdout = await execPromise(execFileImpl, "codexbar", args, { ...options, timeout: remaining });
    } catch {
      throw new QuotaProbeError("CodexBar quota probe failed");
    }
    let raw;
    try {
      raw = JSON.parse(stdout);
    } catch {
      throw new QuotaProbeError("CodexBar returned malformed JSON");
    }
    if (Array.isArray(raw)) {
      if (raw.length !== 1) throw new QuotaProbeError("CodexBar returned an ambiguous provider set");
      [raw] = raw;
    }
    return normalizeCodexbarUsage(raw, subscription, now());
  };
}

// Loopback, by assertion rather than by convention. A hostname outside this set
// is refused at construction, so a mistyped or tampered endpoint fails the desk
// closed instead of sending a provider query — or a future header — off-host.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function assertLoopbackEndpoint(endpoint) {
  let url;
  try {
    url = new URL(String(endpoint));
  } catch {
    throw new DashboardConfigError("CodexBar endpoint is not a valid URL");
  }
  if (url.protocol !== "http:") {
    throw new DashboardConfigError("CodexBar endpoint must be http on loopback");
  }
  if (url.username || url.password) {
    throw new DashboardConfigError("CodexBar endpoint must not carry credentials");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new DashboardConfigError("CodexBar endpoint must be a loopback address");
  }
  return `${url.protocol}//${url.host}`;
}

async function getLoopbackJson(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        // Accept only. No Authorization, no cookie: GET /usage is unauthenticated
        // on a loopback bind, so the desk has no secret to send and cannot leak one.
        headers: { Accept: "application/json" },
        // A redirect is the one way a loopback URL could reach off-host. Refuse it.
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new QuotaProbeError("CodexBar loopback endpoint is unreachable");
    }
    if (!response?.ok) throw new QuotaProbeError("CodexBar loopback endpoint returned an error status");
    let text;
    try {
      text = await response.text();
    } catch {
      throw new QuotaProbeError("CodexBar loopback response could not be read");
    }
    if (text.length > MAX_LOOPBACK_BYTES) throw new QuotaProbeError("CodexBar loopback response is too large");
    try {
      return JSON.parse(text);
    } catch {
      throw new QuotaProbeError("CodexBar returned malformed JSON");
    }
  } finally {
    clearTimeout(timer);
  }
}

// Contract pinned to CodexBar v0.49.6 `serve`: GET /health carries the running
// build, and GET /usage?provider=<id> returns the same document `usage --format
// json` prints. The version gate is the same refusal the CLI probe makes, moved
// to the transport that can actually be asked mid-flight.
export function createLoopbackProbe({
  endpoint = DEFAULT_CODEXBAR_ENDPOINT,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const origin = assertLoopbackEndpoint(endpoint);
  return async function probe(subscription) {
    const started = now();
    const remaining = () => {
      const left = PROBE_TIMEOUT_MS - (now() - started);
      if (left <= 0) throw new QuotaProbeError("CodexBar quota probe timed out");
      return left;
    };
    const health = await getLoopbackJson(fetchImpl, `${origin}/health`, remaining());
    if (!isRecord(health) || health.status !== "ok") {
      throw new QuotaProbeError("CodexBar serve is unhealthy");
    }
    if (health.version !== CODEXBAR_PINNED_VERSION) {
      throw new QuotaProbeError("CodexBar version mismatch");
    }
    let raw = await getLoopbackJson(
      fetchImpl,
      `${origin}/usage?provider=${encodeURIComponent(subscription.provider)}`,
      remaining(),
    );
    if (Array.isArray(raw)) {
      if (raw.length !== 1) throw new QuotaProbeError("CodexBar returned an ambiguous provider set");
      [raw] = raw;
    }
    return normalizeCodexbarUsage(raw, subscription, now());
  };
}

// One probe entry point that routes on the subscription's declared transport, so
// a deployment can move a subscription between them by editing config alone.
export function createDefaultProbe({ endpoint = DEFAULT_CODEXBAR_ENDPOINT, execFileImpl, fetchImpl, now } = {}) {
  const cli = createCodexbarProbe({ execFileImpl, now });
  let loopback = null;
  try {
    loopback = createLoopbackProbe({ endpoint, fetchImpl, now });
  } catch {
    // A bad endpoint disables only the loopback transport; CLI subscriptions and
    // the rest of the dashboard stay up, and loopback rows read unavailable.
    loopback = null;
  }
  return async function probe(subscription) {
    if (subscription.source === "codexbar-loopback") {
      if (!loopback) throw new QuotaProbeError("CodexBar loopback endpoint is not configured");
      return loopback(subscription);
    }
    return cli(subscription);
  };
}

export class QuotaAdapter {
  constructor({
    configPath,
    cachePath,
    endpoint = DEFAULT_CODEXBAR_ENDPOINT,
    probe = createDefaultProbe({ endpoint }),
    now = () => Date.now(),
  }) {
    this.configPath = configPath;
    this.cachePath = cachePath;
    this.probe = probe;
    this.now = now;
    this.inFlight = null;
    this.lastAttemptAt = null;
  }

  async configured() {
    return readDashboardConfig(this.configPath);
  }

  async rows({ refreshIfStale = true } = {}) {
    const config = await this.configured();
    if (!config.subscriptions.length) return [];
    const nowMs = this.now();
    const cached = await readCache(this.cachePath);
    const byId = new Map(cached.map((row) => [row?.id, row]));
    const rows = config.subscriptions.map((subscription) =>
      safeCachedRow(byId.get(subscription.id), subscription, nowMs) ??
      unavailableRow(subscription, new Date(nowMs).toISOString()),
    );
    if (refreshIfStale && rows.some((row) => row.state !== "fresh")) {
      void this.refresh().catch(() => {});
    }
    return rows;
  }

  refresh({ manual = false } = {}) {
    if (this.inFlight) return this.inFlight;
    const nowMs = this.now();
    if (this.lastAttemptAt !== null && nowMs - this.lastAttemptAt < QUOTA_REFRESH_MS) {
      if (manual) throw new QuotaProbeError("Quota refresh is rate-limited to once every five minutes");
      return Promise.resolve(null);
    }
    this.lastAttemptAt = nowMs;
    this.inFlight = this.refreshOnce().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async refreshOnce() {
    const config = await this.configured();
    if (!config.subscriptions.length) return [];
    const cached = await readCache(this.cachePath);
    const byId = new Map(cached.map((row) => [row?.id, row]));
    const at = new Date(this.now()).toISOString();
    const rows = await Promise.all(
      config.subscriptions.map(async (subscription) => {
        try {
          return await this.probe(subscription);
        } catch {
          const good = safeCachedRow(byId.get(subscription.id), subscription, this.now());
          return good ? { ...good, state: "stale" } : unavailableRow(subscription, at);
        }
      }),
    );
    await atomicWriteDashboardCache(this.cachePath, rows);
    return rows;
  }
}

function laneSummary(lane, nowMs) {
  const started = lane.dispatched_ts || lane.created_ts || null;
  const startMs = Date.parse(started ?? "");
  return {
    id: typeof lane.id === "string" ? lane.id : null,
    repo_id: typeof lane.repo_id === "string" ? lane.repo_id : null,
    preset_id: typeof lane.preset_id === "string" ? lane.preset_id : null,
    state: typeof lane.state === "string" ? lane.state : "unknown",
    terminal_class: typeof lane.terminal_class === "string" ? lane.terminal_class : null,
    timeout_s: Number.isFinite(lane.timeout_s) ? lane.timeout_s : null,
    created_ts: typeof lane.created_ts === "string" ? lane.created_ts : null,
    dispatched_ts: typeof lane.dispatched_ts === "string" ? lane.dispatched_ts : null,
    terminal_ts: typeof lane.terminal_ts === "string" ? lane.terminal_ts : null,
    elapsed_s: Number.isFinite(startMs) ? Math.max(0, Math.floor((nowMs - startMs) / 1000)) : null,
  };
}

function attentionItem(id, label, detail, href) {
  return { id, label, detail, href };
}

export function deriveDashboard({ station, broker, orders, subscriptions, nowMs = Date.now() }) {
  const rawLanes = Array.isArray(broker?.lanes) ? broker.lanes : [];
  const summaries = rawLanes.map((lane) => laneSummary(lane, nowMs));
  const active = summaries.filter((lane) => lane.state === "running" || lane.state === "dispatched");
  const queued = summaries.filter((lane) => lane.state === "proposed");
  const terminal = summaries.filter((lane) => lane.state === "terminal");
  const states = {};
  const terminalClasses = {};
  for (const lane of summaries) {
    states[lane.state] = (states[lane.state] ?? 0) + 1;
    if (lane.state === "terminal" && lane.terminal_class) {
      terminalClasses[lane.terminal_class] = (terminalClasses[lane.terminal_class] ?? 0) + 1;
    }
  }
  const recent = summaries
    .slice()
    .sort((a, b) => Date.parse(b.terminal_ts || b.dispatched_ts || b.created_ts || "") - Date.parse(a.terminal_ts || a.dispatched_ts || a.created_ts || ""))
    .slice(0, 12);
  const counts = {
    active: active.length,
    queued: queued.length,
    terminal: terminal.length,
    states,
    terminal_classes: terminalClasses,
  };
  const orderCounts = {
    pending: Number.isFinite(orders?.counts?.pending) ? orders.counts.pending : 0,
    events: Number.isFinite(orders?.counts?.events) ? orders.counts.events : 0,
    approved: Number.isFinite(orders?.counts?.approved) ? orders.counts.approved : 0,
    discarded: Number.isFinite(orders?.counts?.discarded) ? orders.counts.discarded : 0,
  };
  const attention = [];
  if (!broker?.online) {
    attention.push(attentionItem("broker-offline", "Broker offline", "Lane records are unavailable.", "/orchestration"));
  }
  if (!station?.gateway?.reachable) {
    attention.push(attentionItem("gateway-offline", "Gateway offline", "The station is not answering its health probe.", "/"));
  }
  for (const lane of active) {
    if (lane.timeout_s !== null && lane.elapsed_s !== null && lane.elapsed_s > lane.timeout_s) {
      attention.push(attentionItem(`lane-timeout-${lane.id}`, "Lane beyond timeout", `${lane.repo_id || "Lane"} has passed its declared ${lane.timeout_s}s timeout.`, "/orchestration"));
    }
  }
  const unclean = terminal.filter((lane) => lane.terminal_class === "process-unclean");
  if (unclean.length) {
    attention.push(attentionItem("process-unclean", "Process cleanup needs inspection", `${unclean.length} terminal lane${unclean.length === 1 ? " is" : "s are"} classified process-unclean.`, "/orchestration"));
  }
  for (const row of subscriptions) {
    if (row.state === "stale") attention.push(attentionItem(`quota-stale-${row.id}`, `${row.label} quota is stale`, "Showing the last known good snapshot.", "/dashboard"));
    if (row.state === "unavailable") attention.push(attentionItem(`quota-unavailable-${row.id}`, `${row.label} quota unavailable`, "No usable subscription snapshot is available.", "/dashboard"));
  }
  if (orderCounts.pending > 0) {
    attention.push(attentionItem("approvals-waiting", "Approval items waiting", `${orderCounts.pending} item${orderCounts.pending === 1 ? "" : "s"} await your decision.`, "/#queue"));
  }
  const agents = Array.isArray(station?.agents) ? station.agents : [];
  return {
    version: DASHBOARD_VERSION,
    observed_at: new Date(nowMs).toISOString(),
    station: {
      on_duty: Boolean(station?.gateway?.reachable),
      gateway: {
        reachable: Boolean(station?.gateway?.reachable),
        status: typeof station?.gateway?.status === "string" ? station.gateway.status : null,
        latency_ms: Number.isFinite(station?.gateway?.latencyMs) ? station.gateway.latencyMs : null,
      },
      service: {
        active: Boolean(station?.service?.active),
        uptime_seconds: Number.isFinite(station?.service?.uptimeSeconds) ? station.service.uptimeSeconds : null,
      },
      checked_at: typeof station?.checkedAt === "string" ? station.checkedAt : new Date(nowMs).toISOString(),
      channels: Array.isArray(station?.channels) ? station.channels.map((channel) => ({ id: channel.id, policy: channel.policy ?? null })) : [],
      default_model: typeof station?.model === "string" ? station.model : null,
      agents: { configured: agents.length, sandboxed: agents.filter((agent) => agent?.sandboxed).length },
      chat_available: Boolean(station?.chat?.available),
    },
    lanes: { active, queued, recent, counts },
    orders: {
      available: orders?.state === "ok",
      counts: orderCounts,
      calendar_write: Boolean(orders?.calendarWrite),
    },
    subscriptions,
    attention,
  };
}
