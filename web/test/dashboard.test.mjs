import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertLoopbackEndpoint,
  CODEXBAR_PINNED_VERSION,
  createCodexbarProbe,
  createDefaultProbe,
  createLoopbackProbe,
  DashboardConfigError,
  DEFAULT_CODEXBAR_ENDPOINT,
  deriveDashboard,
  MAX_LOOPBACK_BYTES,
  normalizeCodexbarUsage,
  PROBE_TIMEOUT_MS,
  QUOTA_SOURCES,
  QuotaAdapter,
  QuotaProbeError,
  safeCachedRow,
  SUPPORTED_PROVIDERS,
  validateDashboardConfig,
} from "../dashboard.mjs";
import { createDashboardHandlers } from "../server.mjs";

const subscription = {
  id: "codex-primary",
  label: "Codex",
  provider: "codex",
  source: "codexbar-cli",
  probe_source: "cli",
  seat_refs: ["orchestrator", "preset:codex-default"],
  headline_window: "session",
};

const fixture = {
  provider: "codex",
  version: "9.9.9",
  source: "codex-cli",
  usage: {
    primary: { usedPercent: 28, resetsAt: "2026-08-21T19:15:00Z" },
    secondary: { usedPercent: 59, resetsAt: "2026-08-25T13:00:00-04:00" },
    updatedAt: "2026-08-21T16:00:00Z",
    accountEmail: "must-not-reach-browser@example.com",
    token: "must-not-reach-browser",
  },
  command: ["sh", "-c", "must-not-reach-browser"],
  path: "/must/not/reach/browser",
};

function config(...subscriptions) {
  return { version: 1, subscriptions };
}

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "orderly-dashboard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    configPath: join(root, "dashboard-subscriptions.json"),
    cachePath: join(root, "dashboard-cache.json"),
  };
}

test("normalization preserves reset instants, clamps percentages, and emits no provider identity", () => {
  const raw = structuredClone(fixture);
  raw.usage.primary.usedPercent = -8;
  raw.usage.secondary.usedPercent = 120;
  const row = normalizeCodexbarUsage(raw, subscription, Date.parse("2026-08-21T16:00:01Z"));

  assert.equal(row.remaining_pct, 100);
  assert.deepEqual(row.windows, [
    { kind: "session", remaining_pct: 100, resets_at: "2026-08-21T19:15:00Z" },
    { kind: "weekly", remaining_pct: 0, resets_at: "2026-08-25T13:00:00-04:00" },
  ]);
  assert.equal(row.observed_at, "2026-08-21T16:00:00Z");
  assert.equal(row.stale_at, "2026-08-21T16:10:00.000Z");
  const browserShape = JSON.stringify(row);
  for (const forbidden of ["accountEmail", "must-not-reach-browser", "command", "/must/not"]) {
    assert.equal(browserShape.includes(forbidden), false);
  }
});

test("normalization fails closed on provider, percentage, and reset schema mismatches", () => {
  assert.throws(() => normalizeCodexbarUsage({ ...fixture, provider: "claude" }, subscription), QuotaProbeError);
  const badPercentage = structuredClone(fixture);
  badPercentage.usage.primary.usedPercent = "28";
  assert.throws(() => normalizeCodexbarUsage(badPercentage, subscription), QuotaProbeError);
  const badReset = structuredClone(fixture);
  badReset.usage.primary.resetsAt = "2026-08-21T19:15:00";
  assert.throws(() => normalizeCodexbarUsage(badReset, subscription), QuotaProbeError);
});

const windowless = validateDashboardConfig(
  config({
    id: "ollama-primary",
    label: "Ollama Cloud",
    provider: "ollama",
    source: "codexbar-loopback",
    probe_source: "api",
    seat_refs: [],
    headline_window: "session",
  }),
).subscriptions[0];

test("a provider that publishes no quota window renders a status-only row carrying no provider text", () => {
  const raw = {
    provider: "ollama",
    usage: {
      primary: null,
      secondary: null,
      tertiary: null,
      loginMethod: "API key",
      identity: { loginMethod: "API key", providerID: "ollama" },
      updatedAt: "2026-08-21T16:00:00Z",
      accountEmail: "must-not-reach-browser@example.com",
    },
  };
  const row = normalizeCodexbarUsage(raw, windowless, Date.parse("2026-08-21T16:00:01Z"));

  assert.equal(row.state, "fresh");
  // Never 0: an absent window is not an exhausted subscription.
  assert.equal(row.remaining_pct, null);
  assert.equal(row.resets_at, null);
  assert.deepEqual(row.windows, []);
  assert.equal(row.detail, "Active · no quota windows published");
  assert.equal(row.observed_at, "2026-08-21T16:00:00Z");
  assert.equal(row.stale_at, "2026-08-21T16:10:00.000Z");

  const serialized = JSON.stringify(row);
  for (const forbidden of ["identity", "loginMethod", "providerID", "API key", "must-not-reach-browser"]) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} reached the row`);
  }
});

function ranked(provider, headline_window, windows) {
  const sub = validateDashboardConfig(
    config({
      id: `${provider}-primary`,
      label: provider,
      provider,
      source: "codexbar-loopback",
      probe_source: provider === "cursor" ? "web" : "api",
      seat_refs: [],
      headline_window,
    }),
  ).subscriptions[0];
  return normalizeCodexbarUsage(
    { provider, usage: { ...windows, updatedAt: "2026-08-21T16:00:00Z" } },
    sub,
    Date.parse("2026-08-21T16:00:01Z"),
  );
}

test("a genuine session/weekly pair keeps its positional names untouched", () => {
  // 5-hour primary, weekly secondary — Claude, Codex and Z.ai all report this
  // shape, and the positional names are already the truth for it.
  const row = ranked("zai", "session", {
    primary: { usedPercent: 1.9, windowMinutes: 300, resetsAt: "2026-08-21T21:00:00Z" },
    secondary: { usedPercent: 20.5, windowMinutes: 10080, resetsAt: "2026-08-24T00:00:00Z" },
  });
  assert.deepEqual(row.windows.map((w) => w.kind), ["session", "weekly"]);
  assert.equal(row.detail, "session 98.1% remaining; weekly 79.5% remaining");
  assert.equal(row.remaining_pct, 98.1);
});

test("windows with no declared duration keep their positional names", () => {
  const row = ranked("zai", "session", {
    primary: { usedPercent: 28, resetsAt: "2026-08-21T19:15:00Z" },
    secondary: { usedPercent: 59, resetsAt: "2026-08-25T13:00:00Z" },
  });
  assert.deepEqual(row.windows.map((w) => w.kind), ["session", "weekly"]);
});

test("a rank-inverted pair is named by duration, and its headline number is unchanged", () => {
  // Kimi Code ranks its weekly request quota FIRST and its 5-hour rate second,
  // so the positional names reported a session window that does not exist.
  const row = ranked("kimi", "session", {
    primary: { usedPercent: 1, windowMinutes: 10080, resetsAt: "2026-08-28T20:24:07Z" },
    secondary: { usedPercent: 51, windowMinutes: 300, resetsAt: "2026-08-21T21:24:07Z" },
  });
  assert.deepEqual(row.windows.map((w) => w.kind), ["weekly", "5-hour"]);
  // headline_window still selects the same rank it always selected.
  assert.equal(row.remaining_pct, 99);
  assert.equal(row.resets_at, "2026-08-28T20:24:07Z");
});

test("month-long scopes are named monthly and disambiguated by rank, never session or weekly", () => {
  const row = ranked("cursor", "session", {
    primary: { usedPercent: 34.54945054945055, windowMinutes: 44640, resetsAt: "2026-09-08T18:24:36Z" },
    secondary: { usedPercent: 30.57125, windowMinutes: 44640, resetsAt: "2026-09-08T18:24:36Z" },
    tertiary: { usedPercent: 63.481818181818184, windowMinutes: 44640, resetsAt: "2026-09-08T18:24:36Z" },
  });
  assert.deepEqual(row.windows.map((w) => w.kind), [
    "monthly (primary)",
    "monthly (secondary)",
    "monthly (tertiary)",
  ]);
  for (const window of row.windows) assert.ok(window.kind.length <= 40);
  assert.equal(row.remaining_pct, 65.5);
  assert.equal(JSON.stringify(row).includes("session"), false);
  assert.equal(JSON.stringify(row).includes("weekly"), false);
});

test("an unrecognised duration is spelled out rather than named falsely", () => {
  const row = ranked("zai", "session", {
    primary: { usedPercent: 10, windowMinutes: 4320, resetsAt: "2026-08-24T00:00:00Z" },
  });
  assert.deepEqual(row.windows.map((w) => w.kind), ["3-day"]);
  assert.equal(row.remaining_pct, 90);
});

test("the CodexBar probe pins version, fixed argv, minimal environment, and a 30-second bound", async () => {
  const calls = [];
  const fakeExec = (command, args, options, callback) => {
    calls.push({ command, args, options });
    callback(null, calls.length === 1 ? `CodexBar ${CODEXBAR_PINNED_VERSION}\n` : JSON.stringify(fixture));
  };
  const row = await createCodexbarProbe({ fake: true, execFileImpl: fakeExec, now: () => Date.parse("2026-08-21T16:00:01Z") })({
    ...subscription,
    account_index: 2,
  });

  assert.equal(row.remaining_pct, 72);
  assert.deepEqual(calls[0].args, ["--version"]);
  assert.deepEqual(calls[1].args, [
    "usage", "--provider", "codex", "--source", "cli", "--format", "json", "--json-only", "--account-index", "2",
  ]);
  assert.equal(calls.every((call) => call.command === "codexbar"), true);
  assert.equal(calls[0].options.timeout, PROBE_TIMEOUT_MS);
  assert.ok(calls[1].options.timeout <= PROBE_TIMEOUT_MS);
  assert.deepEqual(Object.keys(calls[0].options.env).sort(), ["HOME", "LANG", "LC_ALL", "NO_COLOR", "PATH", "TERM"]);
  assert.equal("OPENCLAW_GATEWAY_TOKEN" in calls[0].options.env, false);
});

test("a different CodexBar version is unavailable before usage is invoked", async () => {
  let calls = 0;
  const probe = createCodexbarProbe({
    execFileImpl: (_command, _args, _options, callback) => {
      calls += 1;
      callback(null, "CodexBar 0.49.5\n");
    },
  });
  await assert.rejects(() => probe(subscription), /version mismatch/);
  assert.equal(calls, 1);
});

test("quota is disabled by default and starts no probe process", async (t) => {
  const paths = await temporary(t);
  let probes = 0;
  const adapter = new QuotaAdapter({
    ...paths,
    probe: async () => {
      probes += 1;
      return {};
    },
  });
  assert.deepEqual(await adapter.rows(), []);
  assert.equal(probes, 0);
});

test("age and failed refresh keep last-known-good values stale and write a mode-0600 whole snapshot", async (t) => {
  const paths = await temporary(t);
  await writeFile(paths.configPath, JSON.stringify(config(subscription)));
  let now = Date.parse("2026-08-21T16:00:00Z");
  let fail = false;
  const adapter = new QuotaAdapter({
    ...paths,
    now: () => now,
    probe: async (configured) => {
      if (fail) throw new Error("raw secret provider failure");
      return normalizeCodexbarUsage(fixture, configured, now);
    },
  });

  await adapter.refresh({ manual: true });
  assert.equal((await adapter.rows({ refreshIfStale: false }))[0].remaining_pct, 72);
  fail = true;
  now += 10 * 60 * 1000 + 1;
  assert.equal((await adapter.rows({ refreshIfStale: false }))[0].state, "stale");
  await adapter.refresh({ manual: true });
  const [stale] = await adapter.rows({ refreshIfStale: false });
  assert.equal(stale.state, "stale");
  assert.equal(stale.remaining_pct, 72);
  assert.equal(stale.windows[1].remaining_pct, 41);
  assert.equal((await stat(paths.cachePath)).mode & 0o777, 0o600);
  const disk = await readFile(paths.cachePath, "utf8");
  assert.equal(disk.includes("raw secret"), false);
  assert.equal(JSON.parse(disk).subscriptions.length, 1);
});

test("malformed first probe creates unavailable nulls rather than zero or a raw error", async (t) => {
  const paths = await temporary(t);
  await writeFile(paths.configPath, JSON.stringify(config(subscription)));
  const adapter = new QuotaAdapter({ ...paths, probe: async () => { throw new Error("token=cookie-secret"); } });
  await adapter.refresh({ manual: true });
  const [row] = await adapter.rows({ refreshIfStale: false });
  assert.equal(row.state, "unavailable");
  assert.equal(row.remaining_pct, null);
  assert.equal(row.resets_at, null);
  assert.equal(row.detail.includes("cookie-secret"), false);
});

test("concurrent quota refreshes coalesce and manual refresh is rate-limited", async (t) => {
  const paths = await temporary(t);
  await writeFile(paths.configPath, JSON.stringify(config(subscription)));
  let release;
  let probes = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const adapter = new QuotaAdapter({
    ...paths,
    now: () => Date.parse("2026-08-21T16:00:00Z"),
    probe: async (configured) => {
      probes += 1;
      await gate;
      return normalizeCodexbarUsage(fixture, configured);
    },
  });
  const first = adapter.refresh({ manual: true });
  const second = adapter.refresh({ manual: true });
  assert.equal(first, second);
  release();
  await first;
  assert.equal(probes, 1);
  assert.throws(() => adapter.refresh({ manual: true }), /rate-limited/);
});

test("configuration accepts supported providers and refuses unsupported or command-like fields", () => {
  assert.equal(validateDashboardConfig(config(subscription)).subscriptions.length, 1);
  assert.throws(() => validateDashboardConfig(config({ ...subscription, command: "sh -c nope" })), /unknown field command/);
  assert.throws(() => validateDashboardConfig(config({ ...subscription, provider: "bedrock" })), /not a supported v1 source/);
});

test("supported providers are frozen and resolve their default local probe sources", () => {
  assert.equal(Object.isFrozen(SUPPORTED_PROVIDERS), true);
  assert.equal(Object.values(SUPPORTED_PROVIDERS).every(Object.isFrozen), true);
  const rows = Object.keys(SUPPORTED_PROVIDERS).map((provider, index) => ({
    id: `subscription-${index}`,
    label: provider,
    provider,
    // A web-only provider has no local strategy at all, so it is declarable
    // only over the loopback transport that keeps the cookie on the serve host.
    source: SUPPORTED_PROVIDERS[provider].includes("web") ? "codexbar-loopback" : "codexbar-cli",
    seat_refs: [],
  }));
  const validated = validateDashboardConfig(config(...rows)).subscriptions;
  const defaults = Object.fromEntries(validated.map((row) => [row.provider, row.probe_source]));
  assert.deepEqual(defaults, {
    codex: "cli",
    claude: "cli",
    openai: "api",
    copilot: "api",
    gemini: "api",
    kilo: "cli",
    openrouter: "api",
    deepseek: "api",
    moonshot: "api",
    kimi: "cli",
    zai: "api",
    ollama: "api",
    cursor: "web",
  });
});

test("a web-only provider is declarable over loopback and refused on every local transport", () => {
  const cursor = {
    id: "cursor-primary",
    label: "Cursor",
    provider: "cursor",
    source: "codexbar-loopback",
    probe_source: "web",
    seat_refs: [],
    headline_window: "session",
  };
  assert.equal(validateDashboardConfig(config(cursor)).subscriptions[0].probe_source, "web");
  // The desk must never fetch a provider cookie itself.
  assert.throws(
    () => validateDashboardConfig(config({ ...cursor, source: "codexbar-cli" })),
    /invalid probe_source/,
  );
  // Declaring it as some other strategy is still outside the provider allowlist.
  assert.throws(
    () => validateDashboardConfig(config({ ...cursor, probe_source: "api" })),
    /invalid probe_source/,
  );
});

test("browser and automatic probe sources are rejected", () => {
  for (const probe_source of ["web", "auto"]) {
    assert.throws(
      () => validateDashboardConfig(config({ ...subscription, probe_source })),
      /invalid probe_source/,
    );
  }
});

test("a provider rejects a probe source outside its local allowlist", () => {
  assert.throws(
    () => validateDashboardConfig(config({ ...subscription, provider: "claude", probe_source: "api" })),
    /invalid probe_source/,
  );
});

test("multi-provider configuration refreshes correct rows without leaking probe or provider extras", async (t) => {
  const paths = await temporary(t);
  const declared = [
    { ...subscription },
    { ...subscription, id: "claude-primary", label: "Claude", provider: "claude", probe_source: undefined },
    { ...subscription, id: "openrouter-primary", label: "OpenRouter", provider: "openrouter", probe_source: undefined },
  ];
  await writeFile(paths.configPath, JSON.stringify(config(...declared)));
  const configured = validateDashboardConfig(config(...declared)).subscriptions;
  assert.deepEqual(configured.map((row) => [row.provider, row.probe_source]), [
    ["codex", "cli"],
    ["claude", "cli"],
    ["openrouter", "api"],
  ]);

  const now = Date.parse("2026-08-21T16:00:01Z");
  const adapter = new QuotaAdapter({
    ...paths,
    now: () => now,
    probe: async (configuredSubscription) => {
      const raw = structuredClone(fixture);
      raw.provider = configuredSubscription.provider;
      raw.usage.identity = { email: "identity-must-not-leak@example.com" };
      raw.providerExtra = { credential: "provider-extra-must-not-leak" };
      return normalizeCodexbarUsage(raw, configuredSubscription, now);
    },
  });
  await adapter.refresh({ manual: true });
  const rows = await adapter.rows({ refreshIfStale: false });
  assert.deepEqual(rows.map((row) => [row.provider, row.remaining_pct, row.source]), [
    ["codex", 72, "codexbar-cli"],
    ["claude", 72, "codexbar-cli"],
    ["openrouter", 72, "codexbar-cli"],
  ]);
  for (const row of rows) {
    assert.equal(Object.hasOwn(row, "identity"), false);
    assert.equal(Object.hasOwn(row, "probe_source"), false);
    assert.equal(Object.hasOwn(row, "providerExtra"), false);
  }
  const serialized = JSON.stringify(rows);
  assert.equal(serialized.includes("identity-must-not-leak"), false);
  assert.equal(serialized.includes("provider-extra-must-not-leak"), false);
});

test("a non-Codex probe uses the configured provider and fixed local source argv", async () => {
  const calls = [];
  const claude = validateDashboardConfig(config({
    ...subscription,
    id: "claude-primary",
    label: "Claude",
    provider: "claude",
    probe_source: "oauth",
  })).subscriptions[0];
  const raw = { ...structuredClone(fixture), provider: "claude" };
  const fakeExec = (command, args, options, callback) => {
    calls.push({ command, args, options });
    callback(null, calls.length === 1 ? `CodexBar ${CODEXBAR_PINNED_VERSION}\n` : JSON.stringify(raw));
  };
  const row = await createCodexbarProbe({
    execFileImpl: fakeExec,
    now: () => Date.parse("2026-08-21T16:00:01Z"),
  })(claude);

  assert.equal(row.provider, "claude");
  assert.deepEqual(calls[1].args, [
    "usage", "--provider", "claude", "--source", "oauth", "--format", "json", "--json-only",
  ]);
});

test("a probe response for a different configured provider is rejected", async () => {
  const claude = validateDashboardConfig(config({
    ...subscription,
    id: "claude-primary",
    label: "Claude",
    provider: "claude",
  })).subscriptions[0];
  let calls = 0;
  const probe = createCodexbarProbe({
    execFileImpl: (_command, _args, _options, callback) => {
      calls += 1;
      callback(null, calls === 1 ? `CodexBar ${CODEXBAR_PINNED_VERSION}\n` : JSON.stringify(fixture));
    },
  });
  await assert.rejects(() => probe(claude), /schema mismatch/);
});

test("a non-Codex cached row round-trips through safeCachedRow", () => {
  const claude = validateDashboardConfig(config({
    ...subscription,
    id: "claude-primary",
    label: "Claude",
    provider: "claude",
  })).subscriptions[0];
  const raw = { ...structuredClone(fixture), provider: "claude" };
  const now = Date.parse("2026-08-21T16:00:01Z");
  const normalized = normalizeCodexbarUsage(raw, claude, now);
  const cached = safeCachedRow(structuredClone(normalized), claude, now);
  assert.deepEqual(cached, normalized);
  assert.equal(Object.hasOwn(cached, "probe_source"), false);
});

test("dashboard derivations preserve broker language and isolate outage and attention labels", () => {
  const nowMs = Date.parse("2026-08-21T16:20:00Z");
  const payload = deriveDashboard({
    nowMs,
    station: {
      gateway: { reachable: false, status: null, latencyMs: null },
      service: { active: true, uptimeSeconds: 3600 },
      agents: [{ id: "coordinator", sandboxed: true }, { id: "mail", sandboxed: false }],
      channels: [{ id: "telegram", policy: "allowlist" }],
      model: "gpt-test",
      chat: { available: true },
      checkedAt: "2026-08-21T16:20:00Z",
    },
    broker: {
      online: false,
      lanes: [
        { id: "active-1", repo_id: "orderly", preset_id: "codex", state: "running", timeout_s: 300, created_ts: "2026-08-21T16:00:00Z", dispatched_ts: "2026-08-21T16:01:00Z" },
        { id: "queued-1", repo_id: "orderly", preset_id: "codex", state: "proposed", timeout_s: 300, created_ts: "2026-08-21T16:10:00Z" },
        { id: "terminal-1", repo_id: "orderly", preset_id: "codex", state: "terminal", terminal_class: "process-unclean", created_ts: "2026-08-21T15:00:00Z", terminal_ts: "2026-08-21T15:10:00Z", log_excerpt: "secret worker prose" },
      ],
    },
    orders: { state: "ok", counts: { pending: 2, events: 1, approved: 3, discarded: 4 }, calendarWrite: false },
    subscriptions: [{ ...normalizeCodexbarUsage(fixture, subscription), state: "stale" }],
  });

  assert.deepEqual(payload.lanes.counts, {
    active: 1,
    queued: 1,
    terminal: 1,
    states: { running: 1, proposed: 1, terminal: 1 },
    terminal_classes: { "process-unclean": 1 },
  });
  assert.equal(payload.lanes.active[0].elapsed_s, 1140);
  assert.equal(payload.station.agents.configured, 2);
  assert.equal(payload.station.agents.sandboxed, 1);
  assert.equal(payload.orders.counts.events, 1);
  const ids = payload.attention.map((item) => item.id);
  for (const id of ["broker-offline", "gateway-offline", "lane-timeout-active-1", "process-unclean", "quota-stale-codex-primary", "approvals-waiting"]) {
    assert.ok(ids.includes(id), `missing ${id}`);
  }
  assert.equal(JSON.stringify(payload).includes("secret worker prose"), false);
});

test("dashboard endpoint handlers serve GET, same-origin refresh, and rate-limit errors", async () => {
  const sent = [];
  const errors = [];
  let refreshes = 0;
  const handlers = createDashboardHandlers({
    originCheck: (req) => req.sameOrigin,
    snapshot: async () => ({ version: 1, subscriptions: [] }),
    refresh: async () => { refreshes += 1; },
    jsonReply: (_res, status, body) => sent.push({ status, body }),
    errorReply: (_res, status, error) => errors.push({ status, error }),
  });
  await handlers.get({}, {});
  await handlers.post({ sameOrigin: false }, {});
  await handlers.post({ sameOrigin: true }, {});
  assert.equal(sent.length, 2);
  assert.equal(sent[0].body.version, 1);
  assert.deepEqual(errors, [{ status: 403, error: "That request didn't come from this page." }]);
  assert.equal(refreshes, 1);

  const limited = createDashboardHandlers({
    originCheck: () => true,
    snapshot: async () => ({}),
    refresh: () => { throw new QuotaProbeError("Quota refresh is rate-limited to once every five minutes"); },
    jsonReply: () => {},
    errorReply: (_res, status, error) => errors.push({ status, error }),
  });
  await limited.post({}, {});
  assert.deepEqual(errors.at(-1), { status: 429, error: "Quota refresh is available once every five minutes." });
});

// ---------------------------------------------------------------------------
// codexbar-loopback — the transport that keeps provider credentials off the desk
// ---------------------------------------------------------------------------

const loopbackSubscription = { ...subscription, source: "codexbar-loopback" };

// `codexbar serve` answers /usage with a one-element array of the same document
// `usage --format json` prints, so the fixture is wrapped exactly as it arrives.
function fakeServe({ version = CODEXBAR_PINNED_VERSION, usage = [structuredClone(fixture)], calls = [] } = {}) {
  return async (url, options) => {
    calls.push({ url: String(url), options });
    const body = String(url).includes("/health")
      ? JSON.stringify({ status: "ok", version })
      : JSON.stringify(usage);
    return { ok: true, text: async () => body };
  };
}

test("the loopback probe pins version, reads health then usage, and sends no credential", async () => {
  const calls = [];
  const row = await createLoopbackProbe({
    endpoint: DEFAULT_CODEXBAR_ENDPOINT,
    fetchImpl: fakeServe({ calls }),
    now: () => Date.parse("2026-08-21T16:00:01Z"),
  })(loopbackSubscription);

  assert.equal(row.remaining_pct, 72);
  assert.equal(row.source, "codexbar-loopback");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "http://127.0.0.1:18791/health");
  assert.equal(calls[1].url, "http://127.0.0.1:18791/usage?provider=codex");
  // No bearer token, no cookie: /usage is unauthenticated on a loopback bind.
  for (const call of calls) {
    assert.deepEqual(Object.keys(call.options.headers), ["Accept"]);
    assert.equal(call.options.redirect, "error");
    assert.ok(call.options.signal);
  }
});

test("loopback rows carry no provider identity into the snapshot", async () => {
  const row = await createLoopbackProbe({ fetchImpl: fakeServe() })(loopbackSubscription);
  const serialized = JSON.stringify(row);
  assert.equal(serialized.includes("must-not-reach-browser"), false);
  assert.equal(serialized.includes("accountEmail"), false);
  assert.deepEqual(Object.keys(row).sort(), [
    "detail", "id", "label", "observed_at", "provider", "remaining_pct",
    "resets_at", "seat_refs", "source", "stale_at", "state", "windows",
  ]);
});

test("a different serve build is unavailable before usage is requested", async () => {
  const calls = [];
  const probe = createLoopbackProbe({ fetchImpl: fakeServe({ version: "0.49.5", calls }) });
  await assert.rejects(() => probe(loopbackSubscription), /version mismatch/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/health"));
});

test("an unhealthy serve is unavailable before usage is requested", async () => {
  const probe = createLoopbackProbe({
    fetchImpl: async (url) =>
      String(url).includes("/health")
        ? { ok: true, text: async () => JSON.stringify({ status: "degraded", version: CODEXBAR_PINNED_VERSION }) }
        : { ok: true, text: async () => "[]" },
  });
  await assert.rejects(() => probe(loopbackSubscription), /unhealthy/);
});

test("only loopback endpoints are accepted, and never with embedded credentials", () => {
  assert.equal(assertLoopbackEndpoint("http://127.0.0.1:18791"), "http://127.0.0.1:18791");
  assert.equal(assertLoopbackEndpoint("http://localhost:18791/"), "http://localhost:18791");
  for (const bad of [
    "http://10.0.0.5:18791",
    "http://192.168.1.9:18791",
    "http://desk-host:18791",
    "http://100.64.0.1:18791",
    "http://example.com",
    "https://127.0.0.1:18791",
    "file:///etc/passwd",
    "not-a-url",
  ]) {
    assert.throws(() => assertLoopbackEndpoint(bad), DashboardConfigError, `expected refusal for ${bad}`);
  }
  assert.throws(() => assertLoopbackEndpoint("http://user:pass@127.0.0.1:18791"), /credentials/);
});

test("a non-loopback endpoint disables only the loopback transport", async () => {
  const probe = createDefaultProbe({
    endpoint: "http://evil.example.com",
    execFileImpl: (_command, _args, _options, callback) => callback(null, `CodexBar ${CODEXBAR_PINNED_VERSION}\n`),
  });
  await assert.rejects(() => probe(loopbackSubscription), /not configured/);
});

test("the default probe routes on the declared transport", async () => {
  const execArgs = [];
  const fetches = [];
  const probe = createDefaultProbe({
    fetchImpl: fakeServe({ calls: fetches }),
    execFileImpl: (_command, args, _options, callback) => {
      execArgs.push(args);
      callback(null, execArgs.length === 1 ? `CodexBar ${CODEXBAR_PINNED_VERSION}\n` : JSON.stringify(fixture));
    },
    now: () => Date.parse("2026-08-21T16:00:01Z"),
  });

  await probe(loopbackSubscription);
  assert.equal(fetches.length, 2);
  assert.equal(execArgs.length, 0);

  await probe(subscription);
  assert.equal(fetches.length, 2);
  assert.equal(execArgs.length, 2);
});

test("an ambiguous or oversized serve response fails closed", async () => {
  const ambiguous = createLoopbackProbe({
    fetchImpl: fakeServe({ usage: [structuredClone(fixture), structuredClone(fixture)] }),
  });
  await assert.rejects(() => ambiguous(loopbackSubscription), /ambiguous/);

  const oversized = createLoopbackProbe({
    fetchImpl: async (url) =>
      String(url).includes("/health")
        ? { ok: true, text: async () => JSON.stringify({ status: "ok", version: CODEXBAR_PINNED_VERSION }) }
        : { ok: true, text: async () => "x".repeat(MAX_LOOPBACK_BYTES + 1) },
  });
  await assert.rejects(() => oversized(loopbackSubscription), /too large/);
});

test("an unreachable or erroring serve is unavailable rather than an exception", async () => {
  const down = createLoopbackProbe({ fetchImpl: async () => { throw new Error("ECONNREFUSED 127.0.0.1:18791"); } });
  await assert.rejects(() => down(loopbackSubscription), QuotaProbeError);

  const failing = createLoopbackProbe({ fetchImpl: async () => ({ ok: false, text: async () => "nope" }) });
  await assert.rejects(() => failing(loopbackSubscription), /error status/);
});

test("every supported provider may be configured over the loopback transport", () => {
  const subscriptions = Object.keys(SUPPORTED_PROVIDERS).map((provider) => ({
    id: `${provider}-primary`,
    label: provider,
    provider,
    source: "codexbar-loopback",
    seat_refs: [`preset:${provider}-default`],
    headline_window: "session",
  }));
  const parsed = validateDashboardConfig(config(...subscriptions));
  assert.equal(parsed.subscriptions.length, Object.keys(SUPPORTED_PROVIDERS).length);
  assert.equal(parsed.subscriptions.every((item) => item.source === "codexbar-loopback"), true);
  assert.deepEqual([...QUOTA_SOURCES], ["codexbar-cli", "codexbar-loopback"]);
  assert.throws(
    () => validateDashboardConfig(config({ ...subscription, source: "codexbar-http" })),
    DashboardConfigError,
  );
});

test("a loopback subscription refreshes end to end and caches no identity at mode 0600", async (t) => {
  const paths = await temporary(t);
  await writeFile(paths.configPath, JSON.stringify(config(loopbackSubscription)), "utf8");
  const adapter = new QuotaAdapter({
    ...paths,
    probe: createLoopbackProbe({ fetchImpl: fakeServe(), now: () => Date.parse("2026-08-21T16:00:01Z") }),
    now: () => Date.parse("2026-08-21T16:00:01Z"),
  });

  const rows = await adapter.refresh({ manual: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "fresh");
  assert.equal(rows[0].remaining_pct, 72);
  assert.equal(rows[0].source, "codexbar-loopback");

  const cached = await readFile(paths.cachePath, "utf8");
  assert.equal(cached.includes("must-not-reach-browser"), false);
  assert.equal(cached.includes("accountEmail"), false);
  assert.equal((await stat(paths.cachePath)).mode & 0o777, 0o600);

  const served = await adapter.rows({ refreshIfStale: false });
  assert.equal(served[0].state, "fresh");
  assert.equal(served[0].windows.length, 2);
});

// Captured verbatim from a live `codexbar serve` v0.49.6 on 2026-08-21:
// GET /usage?provider=ollama. It carries usage.identity and usage.loginMethod,
// which the hand-written fixture above does not — the fields most likely to
// reach a browser by accident. Windows are filled in because no window-bearing
// subscription was reachable on that host; every other field is as served.
const liveEnvelope = {
  provider: "ollama",
  source: "api",
  usage: {
    identity: { loginMethod: "API key", providerID: "ollama" },
    loginMethod: "API key",
    primary: { usedPercent: 28, resetsAt: "2026-08-21T19:15:00Z" },
    secondary: { usedPercent: 59, resetsAt: "2026-08-25T13:00:00Z" },
    tertiary: null,
    updatedAt: "2026-08-21T17:14:11Z",
  },
};

test("the real serve envelope normalizes and strips its identity block", () => {
  const row = normalizeCodexbarUsage(structuredClone(liveEnvelope), {
    ...loopbackSubscription,
    provider: "ollama",
    id: "ollama-primary",
    label: "Ollama Cloud",
  }, Date.parse("2026-08-21T17:14:12Z"));

  assert.equal(row.remaining_pct, 72);
  assert.equal(row.windows.length, 2);
  assert.equal(row.observed_at, "2026-08-21T17:14:11Z");
  const serialized = JSON.stringify(row);
  for (const forbidden of ["identity", "loginMethod", "providerID", "API key"]) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} reached the row`);
  }
});

test("a serve envelope with every window null is status-only, never zero", () => {
  // Balance-only providers, and providers with no token accounting at all,
  // answer successfully with no quota window. That must never read as 0%
  // remaining; it reports the steady state and shows no meter.
  const balanceOnly = structuredClone(liveEnvelope);
  balanceOnly.usage.primary = null;
  balanceOnly.usage.secondary = null;
  const row = normalizeCodexbarUsage(balanceOnly, { ...loopbackSubscription, provider: "ollama" });
  assert.equal(row.remaining_pct, null);
  assert.equal(row.resets_at, null);
  assert.deepEqual(row.windows, []);
  assert.equal(row.detail, "Active · no quota windows published");
});

test("a provider-level serve error never becomes a populated row", () => {
  const failed = { provider: "codex", source: "oauth", error: { message: "token expired", code: 1 } };
  assert.throws(() => normalizeCodexbarUsage(failed, loopbackSubscription), QuotaProbeError);
});

test("Kimi Code is a distinct provider from the Moonshot open-platform balance", () => {
  // Verified live on a v0.49.6 serve: provider=kimi returns the Kimi Code
  // subscription's weekly request quota and 5-hour rate window, while
  // provider=moonshot returns an open-platform credit balance with no windows.
  assert.deepEqual([...SUPPORTED_PROVIDERS.kimi], ["api", "cli"]);
  assert.deepEqual([...SUPPORTED_PROVIDERS.moonshot], ["api"]);
  const parsed = validateDashboardConfig(
    config({
      id: "kimi-primary",
      label: "Kimi",
      provider: "kimi",
      source: "codexbar-loopback",
      seat_refs: ["preset:kimi-default"],
      headline_window: "session",
    }),
  );
  // cli leads kimi's allowlist, so it is the default when none is declared.
  assert.equal(parsed.subscriptions[0].probe_source, "cli");
  assert.equal(parsed.subscriptions[0].provider, "kimi");
});

const claudeSubscription = {
  id: "claude-primary",
  label: "Claude",
  provider: "claude",
  source: "codexbar-loopback",
  probe_source: "oauth",
  seat_refs: ["orchestrator"],
  headline_window: "session",
};

// Captured from the live serve: the Claude subscription reports a third window
// that is scoped to one model rather than ranked below the other two, and it
// arrives in a titled list instead of a named field. The desk showed the ranked
// pair and silently dropped this one.
const claudeEnvelope = {
  provider: "claude",
  source: "oauth",
  usage: {
    identity: { loginMethod: "OAuth", accountEmail: "must-not-reach-browser@example.com" },
    primary: { usedPercent: 41, resetsAt: "2026-08-21T19:00:00Z" },
    secondary: { usedPercent: 62, resetsAt: "2026-08-28T13:00:00Z" },
    tertiary: null,
    extraRateWindows: [
      {
        window: {
          windowMinutes: 10080,
          usedPercent: 13,
          resetDescription: "Aug 28 at 9:00AM",
          resetsAt: "2026-08-28T13:00:00Z",
        },
        title: "Fable only",
        id: "claude-weekly-scoped-fable",
      },
    ],
    updatedAt: "2026-08-21T17:14:11Z",
  },
};

test("a scoped extra window is rendered beside the ranked pair, under its own title", () => {
  const row = normalizeCodexbarUsage(
    structuredClone(claudeEnvelope),
    claudeSubscription,
    Date.parse("2026-08-21T17:14:12Z"),
  );

  assert.deepEqual(row.windows, [
    { kind: "session", remaining_pct: 59, resets_at: "2026-08-21T19:00:00Z" },
    { kind: "weekly", remaining_pct: 38, resets_at: "2026-08-28T13:00:00Z" },
    { kind: "Fable only", remaining_pct: 87, resets_at: "2026-08-28T13:00:00Z" },
  ]);
  // The headline still comes from the ranked window the subscription declared.
  assert.equal(row.remaining_pct, 59);
  assert.equal(row.detail, "session 59% remaining; weekly 38% remaining; Fable only 87% remaining");
  const serialized = JSON.stringify(row);
  for (const forbidden of ["identity", "accountEmail", "must-not-reach-browser", "windowMinutes"]) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} reached the row`);
  }
});

test("the extra window's label is whatever the provider titles it, never a fixed name", () => {
  const renamed = structuredClone(claudeEnvelope);
  renamed.usage.extraRateWindows = [
    { window: { usedPercent: 4, resetsAt: "2026-08-28T13:00:00Z" }, title: "Opus only", id: "scoped-opus" },
    { window: { usedPercent: 90, resetsAt: null }, id: "scoped-untitled" },
  ];
  const row = normalizeCodexbarUsage(renamed, claudeSubscription);
  assert.deepEqual(row.windows.slice(2), [
    { kind: "Opus only", remaining_pct: 96, resets_at: "2026-08-28T13:00:00Z" },
    // No title: the identifier names it rather than a made-up one.
    { kind: "scoped-untitled", remaining_pct: 10, resets_at: null },
  ]);
});

test("a provider reporting no extra windows renders exactly the ranked pair", () => {
  const bare = structuredClone(claudeEnvelope);
  delete bare.usage.extraRateWindows;
  const absent = normalizeCodexbarUsage(bare, claudeSubscription, Date.parse("2026-08-21T17:14:12Z"));
  const explicitNull = structuredClone(claudeEnvelope);
  explicitNull.usage.extraRateWindows = null;
  const empty = structuredClone(claudeEnvelope);
  empty.usage.extraRateWindows = [];

  assert.deepEqual(absent.windows, [
    { kind: "session", remaining_pct: 59, resets_at: "2026-08-21T19:00:00Z" },
    { kind: "weekly", remaining_pct: 38, resets_at: "2026-08-28T13:00:00Z" },
  ]);
  assert.equal(absent.detail, "session 59% remaining; weekly 38% remaining");
  for (const variant of [explicitNull, empty]) {
    const row = normalizeCodexbarUsage(variant, claudeSubscription, Date.parse("2026-08-21T17:14:12Z"));
    assert.deepEqual(row.windows, absent.windows);
    assert.equal(row.detail, absent.detail);
  }
});

test("a malformed extra window fails closed rather than rendering a made-up bar", () => {
  for (const broken of [
    { usage: { extraRateWindows: {} } },
    { usage: { extraRateWindows: ["Fable only"] } },
    { usage: { extraRateWindows: [{ title: "Fable only" }] } },
    { usage: { extraRateWindows: [{ window: { usedPercent: "13" }, title: "Fable only" }] } },
    { usage: { extraRateWindows: [{ window: { usedPercent: 13, resetsAt: "2026-08-28T09:00" }, title: "x" }] } },
    { usage: { extraRateWindows: [{ window: { usedPercent: 13 }, title: 7 }] } },
  ]) {
    const raw = structuredClone(claudeEnvelope);
    raw.usage.extraRateWindows = broken.usage.extraRateWindows;
    assert.throws(() => normalizeCodexbarUsage(raw, claudeSubscription), QuotaProbeError);
  }
});

test("a scoped window survives the cache with its label clamped like any other kind", () => {
  const row = normalizeCodexbarUsage(structuredClone(claudeEnvelope), claudeSubscription);
  const cached = safeCachedRow(JSON.parse(JSON.stringify(row)), claudeSubscription, Date.parse("2026-08-21T17:15:00Z"));
  assert.deepEqual(cached.windows, row.windows);

  const overlong = JSON.parse(JSON.stringify(row));
  overlong.windows[2].kind = "F".repeat(200);
  assert.equal(safeCachedRow(overlong, claudeSubscription, Date.parse("2026-08-21T17:15:00Z")).windows[2].kind.length, 40);
});

test("a scoped window reaches the browser snapshot end to end", async (t) => {
  const paths = await temporary(t);
  await writeFile(paths.configPath, JSON.stringify(config(claudeSubscription)), "utf8");
  const adapter = new QuotaAdapter({
    ...paths,
    probe: createLoopbackProbe({
      fetchImpl: fakeServe({ usage: [structuredClone(claudeEnvelope)] }),
      now: () => Date.parse("2026-08-21T17:14:12Z"),
    }),
    now: () => Date.parse("2026-08-21T17:14:12Z"),
  });

  const [refreshed] = await adapter.refresh({ manual: true });
  assert.equal(refreshed.state, "fresh");
  assert.deepEqual(refreshed.windows.map((window) => window.kind), ["session", "weekly", "Fable only"]);

  const [served] = await adapter.rows({ refreshIfStale: false });
  assert.deepEqual(served.windows.map((window) => window.kind), ["session", "weekly", "Fable only"]);
  assert.equal(served.windows[2].remaining_pct, 87);
  const cached = await readFile(paths.cachePath, "utf8");
  assert.equal(cached.includes("Fable only"), true);
  assert.equal(cached.includes("must-not-reach-browser"), false);
});
