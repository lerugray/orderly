// Seat engines: resolution, the tier ceiling, the configuration probe, and the
// two write paths. Nothing here needs a model or a network — the endpoint is a
// stand-in in this process, which is the point: a station must be able to say
// whether its configuration is right before anyone starts a model.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  EngineRefused,
  HARNESSES,
  applyEngineEdits,
  applyOverlayEdits,
  checkOperation,
  describeEngine,
  probeEngine,
  readEngineConfig,
  resolveSeatEngine,
  sanitizeUrl,
  validateEngineConfig,
} from "../engines.mjs";
import { writeProviderDefinition, Refused } from "../settings.mjs";
import { startMockEngine } from "./engine-mocks.mjs";

// A station shaped like the deployed one: a cloud provider with a fallback, and
// room for a local endpoint beside it.
function station({ localBaseUrl = "http://127.0.0.1:1/v1" } = {}) {
  return {
    gateway: { mode: "local", port: 18789, reload: { mode: "hybrid" } },
    channels: {},
    bindings: [],
    browser: { enabled: false },
    tools: { deny: ["browser"], elevated: { enabled: false } },
    commands: { ownerAllowFrom: ["telegram:1"] },
    meta: { lastTouchedVersion: "2026.7.1-2" },
    models: {
      mode: "merge",
      providers: {
        "ollama-cloud-openai": {
          baseUrl: "https://ollama.com/v1",
          api: "openai-completions",
          auth: "api-key",
          apiKey: { source: "env", provider: "default", id: "OLLAMA_CLOUD_API_KEY" },
          authHeader: true,
          timeoutSeconds: 120,
          models: [
            { id: "glm-5.2", name: "GLM 5.2", input: ["text"], contextWindow: 128000, maxTokens: 8192 },
            { id: "qwen3.5:397b", name: "Qwen", input: ["text"], contextWindow: 128000, maxTokens: 8192 },
          ],
        },
        "local-ollama": {
          baseUrl: localBaseUrl,
          api: "openai-completions",
          auth: "none",
          timeoutSeconds: 120,
          models: [{ id: "llama3.1:8b", name: "Llama 3.1 8B", input: ["text"], contextWindow: 8192, maxTokens: 1024 }],
        },
      },
    },
    agents: {
      defaults: {
        workspace: "~/.openclaw/workspace",
        model: { primary: "ollama-cloud-openai/glm-5.2", fallbacks: ["ollama-cloud-openai/qwen3.5:397b"] },
        sandbox: { mode: "all", backend: "docker" },
        skills: [],
      },
      list: [
        { id: "coordinator", tools: { profile: "core" }, sandbox: { mode: "all" } },
        { id: "researcher", tools: { profile: "core" }, sandbox: { mode: "all" } },
      ],
    },
  };
}

function overlayFor(seat = {}, models = {}) {
  return {
    version: 1,
    models: {
      "local-ollama/llama3.1:8b": { toolProtocol: "none", tiers: ["chat-research"] },
      ...models,
    },
    seats: { coordinator: { capabilityTier: "chat-research", contextBudget: 4096, ...seat } },
  };
}

function localSeat(config) {
  config.agents.list[0].model = { primary: "local-ollama/llama3.1:8b" };
  return config;
}

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

test("a station with no engine file leaves every seat unclassified and infers nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orderly-engines-"));
  try {
    const file = await readEngineConfig({ path: join(dir, "engines.json") });
    assert.equal(file.present, false);
    assert.equal(file.error, null);

    const binding = resolveSeatEngine({ gatewayConfig: station(), overlay: file.overlay, seatId: "coordinator" });
    assert.equal(binding.classified, false);
    assert.equal(binding.capabilityTier, null);
    // The two claims nothing is allowed to invent: what it can do, and what it
    // speaks. Both stay unstated rather than becoming a default.
    assert.equal(binding.toolProtocol, null);
    assert.deepEqual(binding.qualifiedTiers, []);
    assert.equal(describeEngine(binding).capabilityTier, "unclassified");
    assert.equal(describeEngine(binding).toolProtocol, "undeclared");

    // ...and an unclassified seat is not gated, because it worked before this
    // feature existed and must go on working.
    assert.equal(checkOperation({ binding, operationClass: "chat" }).allowed, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a per-agent model block replaces the default one instead of inheriting its fallbacks", () => {
  const config = localSeat(station());
  const binding = resolveSeatEngine({ gatewayConfig: config, overlay: overlayFor(), seatId: "coordinator" });
  assert.equal(binding.modelRef, "local-ollama/llama3.1:8b");
  assert.equal(binding.modelSource, "seat");
  // The cloud fallbacks belong to the default binding. Carrying them onto a
  // seat deliberately pointed at the operator's own box would cross endpoints
  // nobody paired.
  assert.deepEqual(binding.fallbacks, []);

  // A seat with no override still inherits the whole default binding.
  const inherited = resolveSeatEngine({ gatewayConfig: config, overlay: overlayFor(), seatId: "researcher" });
  assert.equal(inherited.modelRef, "ollama-cloud-openai/glm-5.2");
  assert.deepEqual(inherited.fallbacks.map((f) => f.ref), ["ollama-cloud-openai/qwen3.5:397b"]);
});

test("a seat's disclosure names the credential's variable and never a value", () => {
  const description = describeEngine(
    resolveSeatEngine({ gatewayConfig: station(), overlay: overlayFor(), seatId: "coordinator" }),
  );
  assert.equal(description.credentialRef, "OLLAMA_CLOUD_API_KEY");
  assert.equal(description.endpoint, "https://ollama.com/v1");
  assert.equal(description.contextWindow, 128000);
  assert.equal(description.contextBudget, 4096);
  assert.equal(description.maxTokens, 8192);
  assert.equal(description.api, "openai-completions");
  assert.equal(JSON.stringify(description).includes("apiKey"), false);
});

test("an address carrying a credential is never displayed with it", () => {
  assert.equal(sanitizeUrl("https://user:secret@example.test:8443/v1?key=hunter2"), "https://example.test:8443/v1");
});

test("a seat naming a model this station doesn't have is refused by name", () => {
  const config = station();
  config.agents.list[0].model = { primary: "local-ollama/not-installed" };
  assert.throws(
    () => resolveSeatEngine({ gatewayConfig: config, overlay: overlayFor(), seatId: "coordinator" }),
    (err) => err instanceof EngineRefused && /doesn't have configured/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

test("coding-lane is refused as a seat tier, in the file and in the typed edit alike", () => {
  const config = localSeat(station());
  const overlay = overlayFor({ capabilityTier: "coding-lane" });
  const { ok, problems } = validateEngineConfig({ overlay, gatewayConfig: config });
  assert.equal(ok, false);
  assert.match(problems[0].message, /dispatch broker/);

  assert.throws(
    () => applyOverlayEdits(overlayFor(), { seats: { coordinator: { capabilityTier: "coding-lane" } } }),
    (err) => err instanceof EngineRefused && /not a tier a chat seat can be set to/.test(err.message),
  );
  // And a model cannot be declared qualified for it either, so there is no
  // second door in.
  assert.throws(
    () =>
      applyOverlayEdits(overlayFor(), {
        models: { "local-ollama/llama3.1:8b": { toolProtocol: "none", tiers: ["coding-lane"] } },
      }),
    (err) => err instanceof EngineRefused,
  );
});

test("a chained-task seat is refused with the reason, not stubbed and not downgraded", () => {
  const config = localSeat(station());
  const overlay = overlayFor(
    { capabilityTier: "chained-task", harnessRef: "bounded-sequencer-v1" },
    { "local-ollama/llama3.1:8b": { toolProtocol: "openai-tools", tiers: ["chained-task"] } },
  );
  const { ok, problems } = validateEngineConfig({ overlay, gatewayConfig: config });
  assert.equal(ok, false);
  assert.equal(HARNESSES["bounded-sequencer-v1"].available, false);
  // The error says which harness, and that this build does not have it. It does
  // not silently become chat-research, and nothing pretends to chain.
  assert.ok(problems.some((p) => /bounded-sequencer-v1/.test(p.message) && /not built in this release/.test(p.message)));
});

test("a chained-task seat naming no harness is refused, because the tier is the pair", () => {
  const config = localSeat(station());
  const overlay = overlayFor({ capabilityTier: "chained-task" });
  const { problems } = validateEngineConfig({ overlay, gatewayConfig: config });
  assert.ok(problems.some((p) => /model AND a harness together/.test(p.message)));
});

test("a chat-research seat may not name a harness", () => {
  const config = localSeat(station());
  const overlay = overlayFor({ harnessRef: "bounded-sequencer-v1" });
  const { problems } = validateEngineConfig({ overlay, gatewayConfig: config });
  assert.ok(problems.some((p) => /runs no harness/.test(p.message)));
});

test("a budget that leaves no room for the reply is refused with all three numbers", () => {
  const config = localSeat(station());
  const overlay = overlayFor({ contextBudget: 8000 }); // window 8192, reply reserves 1024
  const { problems } = validateEngineConfig({ overlay, gatewayConfig: config });
  const hit = problems.find((p) => /for the reply/.test(p.message));
  assert.ok(hit);
  assert.match(hit.message, /8000/);
  assert.match(hit.message, /1024/);
  assert.match(hit.message, /8192/);

  const over = validateEngineConfig({ overlay: overlayFor({ contextBudget: 9000 }), gatewayConfig: config });
  assert.ok(over.problems.some((p) => /context window is 8192/.test(p.message)));
});

test("a tier a model has not been reviewed for is refused, rather than assumed from the seat", () => {
  const config = localSeat(station());
  const overlay = overlayFor({}, { "local-ollama/llama3.1:8b": { toolProtocol: "none", tiers: ["chained-task"] } });
  const { problems } = validateEngineConfig({ overlay, gatewayConfig: config });
  assert.ok(problems.some((p) => /has not been declared as qualified for it/.test(p.message)));
});

test("a fallback qualified for less than the seat's tier is refused", () => {
  const config = station();
  config.agents.list[0].model = {
    primary: "ollama-cloud-openai/glm-5.2",
    fallbacks: ["ollama-cloud-openai/qwen3.5:397b"],
  };
  const overlay = overlayFor(
    {},
    {
      "ollama-cloud-openai/glm-5.2": { toolProtocol: "openai-tools", tiers: ["chat-research"] },
      // reviewed for nothing this seat is set to
      "ollama-cloud-openai/qwen3.5:397b": { toolProtocol: "none", tiers: [] },
    },
  );
  const { problems } = validateEngineConfig({ overlay, gatewayConfig: config });
  assert.ok(problems.some((p) => /isn't qualified for chat-research/.test(p.message)));
});

test("a model with no declared tool protocol is refused rather than guessed at", () => {
  const config = localSeat(station());
  const overlay = overlayFor({}, { "local-ollama/llama3.1:8b": { tiers: ["chat-research"] } });
  const { problems } = validateEngineConfig({ overlay, gatewayConfig: config });
  assert.ok(problems.some((p) => /toolProtocol/.test(p.message) && /never guesses/.test(p.message)));
});

// ---------------------------------------------------------------------------
// the tier ceiling
// ---------------------------------------------------------------------------

test("chat-research answers and uses one tool, and refuses a chain in words", () => {
  const config = localSeat(station());
  const overlay = overlayFor({}, { "local-ollama/llama3.1:8b": { toolProtocol: "openai-tools", tiers: ["chat-research"] } });
  const binding = resolveSeatEngine({ gatewayConfig: config, overlay, seatId: "coordinator" });

  assert.equal(checkOperation({ binding, operationClass: "chat" }).allowed, true);
  assert.equal(checkOperation({ binding, operationClass: "singleStepTool" }).allowed, true);

  const chained = checkOperation({ binding, operationClass: "chainedTask" });
  assert.equal(chained.allowed, false);
  // §2.5.6: what was asked, what the ceiling is, what is missing, what to do.
  assert.equal(chained.refusal.requested, "chainedTask");
  assert.equal(chained.refusal.activeTier, "chat-research");
  assert.match(chained.refusal.missing, /harness/);
  assert.ok(chained.refusal.nextAction.length > 0);
  assert.match(chained.refusal.message, /will not run part of one and call it done/);
});

test("a coding lane is unreachable from a chat seat, classified or not", () => {
  const config = localSeat(station());
  const classified = resolveSeatEngine({ gatewayConfig: config, overlay: overlayFor(), seatId: "coordinator" });
  const unclassified = resolveSeatEngine({ gatewayConfig: config, overlay: { version: 1, models: {}, seats: {} }, seatId: "coordinator" });

  for (const binding of [classified, unclassified]) {
    const decision = checkOperation({ binding, operationClass: "codingLane" });
    assert.equal(decision.allowed, false);
    assert.match(decision.refusal.message, /separate, pinned seat behind the dispatch broker/);
  }
});

test("a seat somehow classified coding-lane refuses every operation with its own accurate message", () => {
  const config = localSeat(station());
  const binding = resolveSeatEngine({ gatewayConfig: config, overlay: overlayFor(), seatId: "coordinator" });
  // The config validator and the typed edit both refuse coding-lane as a seat
  // tier; force the invalid state to prove the runtime gate is accurate if one
  // ever reaches it, instead of reusing the chat-research chained-task text.
  binding.capabilityTier = "coding-lane";
  binding.classified = true;
  for (const op of ["chat", "singleStepTool", "chainedTask"]) {
    const decision = checkOperation({ binding, operationClass: op });
    assert.equal(decision.allowed, false);
    assert.equal(decision.refusal.activeTier, "coding-lane");
    assert.match(decision.refusal.message, /not a tier a chat seat can run/);
    // Never the chat-research chained-task line, which would falsely claim this
    // seat "can answer, and it can use one tool in a turn".
    assert.equal(/can answer, and it can use one tool/.test(decision.refusal.message), false);
  }
});

test("an engine that speaks no tool protocol says tools are unavailable rather than trying one", () => {
  const config = localSeat(station());
  const binding = resolveSeatEngine({ gatewayConfig: config, overlay: overlayFor(), seatId: "coordinator" });
  assert.equal(binding.toolProtocol, "none");
  const decision = checkOperation({ binding, operationClass: "singleStepTool" });
  assert.equal(decision.allowed, false);
  assert.match(decision.refusal.message, /tools are unavailable/);
  // Chat still works. A small model that cannot call tools is still a model.
  assert.equal(checkOperation({ binding, operationClass: "chat" }).allowed, true);
});

// ---------------------------------------------------------------------------
// the configuration probe
// ---------------------------------------------------------------------------

async function probeLocal(engine, overrides = {}) {
  return probeEngine({
    binding: {
      providerId: "local-ollama",
      modelId: "llama3.1:8b",
      baseUrl: engine.baseUrl,
      api: "openai-completions",
      auth: "none",
      apiKeyEnv: null,
      contextWindow: 8192,
      maxTokens: 1024,
      contextBudget: 4096,
      toolProtocol: "none",
      capabilityTier: "chat-research",
      harnessRef: null,
      ...overrides,
    },
    timeoutMs: 4000,
  });
}

test("a local endpoint with no key probes clean, and no key is invented for it", async (t) => {
  const engine = await startMockEngine();
  t.after(() => engine.close());
  const result = await probeLocal(engine);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(
    result.stages.map((s) => s.stage),
    ["url", "reachability", "auth", "api", "model-tag", "completion", "protocol", "limits"],
  );
  // §4.1.6 — the common local case sends no Authorization header at all.
  assert.deepEqual(new Set(engine.calls.authHeaders), new Set([null]));
});

test("an endpoint nothing is listening on fails at reachability, naming the endpoint", async () => {
  const result = await probeEngine({
    binding: {
      providerId: "local-ollama",
      modelId: "llama3.1:8b",
      baseUrl: "http://127.0.0.1:1/v1",
      api: "openai-completions",
      auth: "none",
      contextWindow: 8192,
      maxTokens: 1024,
    },
    timeoutMs: 2000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failedStage, "reachability");
  assert.match(result.message, /http:\/\/127\.0\.0\.1:1\/v1/);
});

test("a provider that declares a credential is deferred to the gateway, not read or sent from the desk", async (t) => {
  const engine = await startMockEngine({ key: "the-real-key" });
  t.after(() => engine.close());
  const result = await probeEngine({
    binding: {
      providerId: "cloudy",
      modelId: "llama3.1:8b",
      baseUrl: engine.baseUrl,
      api: "openai-completions",
      auth: "api-key",
      apiKeyEnv: "ORDERLY_TEST_KEY",
      contextWindow: 8192,
      maxTokens: 1024,
    },
    timeoutMs: 4000,
  });
  // Deferred, not failed: a working cloud seat can still be classified, and the
  // gateway — the credential owner (§4.2.2) — verifies the endpoint at activation.
  assert.equal(result.ok, true);
  assert.equal(result.deferred, true);
  assert.equal(result.failedStage, null);
  assert.match(result.message, /gateway/);
  // The desk contacted the endpoint for nothing — no unauthenticated request and,
  // above all, no credentialed one — because it holds no provider credentials.
  assert.equal(engine.calls.models, 0);
  assert.equal(engine.calls.completions, 0);
  assert.deepEqual(engine.calls.authHeaders, []);
});

test("the desk reads no environment variable and sends no Authorization header, even when the named variable is set", async (t) => {
  const engine = await startMockEngine();
  t.after(() => engine.close());
  // A secret is present in THIS process's environment and is exactly the one the
  // (untrusted) binding names — the credential-exfiltration setup this fix closes.
  process.env.ORDERLY_TEST_LEAK_CANARY = "canary-value-must-never-travel";
  t.after(() => {
    delete process.env.ORDERLY_TEST_LEAK_CANARY;
  });
  const result = await probeEngine({
    binding: {
      providerId: "cloudy",
      modelId: "llama3.1:8b",
      baseUrl: engine.baseUrl,
      api: "openai-completions",
      auth: "api-key",
      apiKeyEnv: "ORDERLY_TEST_LEAK_CANARY",
      contextWindow: 8192,
      maxTokens: 1024,
    },
    timeoutMs: 4000,
  });
  assert.equal(result.deferred, true);
  // It never leaves: no request was made at all, and the value appears nowhere
  // in the report.
  assert.deepEqual(engine.calls.authHeaders, []);
  assert.equal(JSON.stringify(result).includes("canary-value-must-never-travel"), false);
});

test("an endpoint serving a different tag fails on the exact tag, not on a family", async (t) => {
  const engine = await startMockEngine({ models: [{ id: "llama3.1:70b" }] });
  t.after(() => engine.close());
  const result = await probeLocal(engine);
  assert.equal(result.failedStage, "model-tag");
  assert.match(result.message, /exactly "llama3\.1:8b"/);
});

test("a reply that isn't OpenAI-shaped fails at protocol rather than being read anyway", async (t) => {
  const engine = await startMockEngine({ brokenProtocol: true });
  t.after(() => engine.close());
  const result = await probeLocal(engine);
  assert.equal(result.failedStage, "protocol");
});

test("a context window larger than the endpoint's own report fails at limits", async (t) => {
  const engine = await startMockEngine({ models: [{ id: "llama3.1:8b", context_length: 4096 }] });
  t.after(() => engine.close());
  const result = await probeLocal(engine);
  assert.equal(result.failedStage, "limits");
  assert.match(result.message, /8192-token window, but/);
  assert.match(result.message, /4096/);
});

test("a declared tool protocol is proven with one synthetic call, and two is a failure", async (t) => {
  const good = await startMockEngine({ toolCalls: 1 });
  t.after(() => good.close());
  const passes = await probeLocal(good, { toolProtocol: "openai-tools" });
  assert.equal(passes.ok, true, passes.message);
  assert.ok(passes.stages.some((s) => s.stage === "tools" && s.ok));

  const chatty = await startMockEngine({ toolCalls: 2 });
  t.after(() => chatty.close());
  const fails = await probeLocal(chatty, { toolProtocol: "openai-tools" });
  assert.equal(fails.failedStage, "tools");
  assert.match(fails.message, /made 2 tool calls when asked for exactly one/);

  const silent = await startMockEngine({ toolCalls: 0 });
  t.after(() => silent.close());
  const quiet = await probeLocal(silent, { toolProtocol: "openai-tools" });
  assert.equal(quiet.failedStage, "tools");
});

test("a chained-task binding cannot be probed clean, because there is no harness to probe", async (t) => {
  const engine = await startMockEngine();
  t.after(() => engine.close());
  const result = await probeLocal(engine, { capabilityTier: "chained-task", harnessRef: "bounded-sequencer-v1" });
  assert.equal(result.ok, false);
  assert.equal(result.failedStage, "harness");
  // The endpoint is fine and the report says so; what is missing is ours.
  assert.match(result.message, /endpoint is fine/);
});

test("an address with a credential in it is refused before anything is reached", async () => {
  const result = await probeEngine({
    binding: {
      providerId: "local-ollama",
      modelId: "llama3.1:8b",
      baseUrl: "http://user:secret@127.0.0.1:9/v1",
      api: "openai-completions",
      auth: "none",
    },
    timeoutMs: 1000,
  });
  assert.equal(result.failedStage, "url");
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("an API mode this build can't speak is refused rather than probed and claimed", async (t) => {
  const engine = await startMockEngine();
  t.after(() => engine.close());
  const result = await probeLocal(engine, { api: "anthropic-messages" });
  assert.equal(result.failedStage, "api");
  assert.match(result.message, /will not claim to have checked/);
});

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

test("a classification whose probe fails is not written, and says so", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orderly-engines-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "engines.json");
  const config = localSeat(station()); // local provider points at a dead port

  const result = await applyEngineEdits({
    path,
    overlay: { version: 1, models: {}, seats: {} },
    gatewayConfig: config,
    edits: {
      models: { "local-ollama/llama3.1:8b": { toolProtocol: "none", tiers: ["chat-research"] } },
      seats: { coordinator: { capabilityTier: "chat-research", contextBudget: 4096 } },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "probe");
  assert.equal(result.retained, true);
  assert.match(result.problems[0].message, /still running what it was/);
  await assert.rejects(readFile(path, "utf8"));
});

test("a classification that probes clean is written and reads back the same", async (t) => {
  const engine = await startMockEngine();
  t.after(() => engine.close());
  const dir = await mkdtemp(join(tmpdir(), "orderly-engines-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "engines.json");
  const config = localSeat(station({ localBaseUrl: engine.baseUrl }));

  const result = await applyEngineEdits({
    path,
    overlay: { version: 1, models: {}, seats: {} },
    gatewayConfig: config,
    edits: {
      models: { "local-ollama/llama3.1:8b": { toolProtocol: "none", tiers: ["chat-research"] } },
      seats: { coordinator: { capabilityTier: "chat-research", contextBudget: 4096 } },
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result.problems));

  const reread = await readEngineConfig({ path });
  assert.equal(reread.present, true);
  const binding = resolveSeatEngine({ gatewayConfig: config, overlay: reread.overlay, seatId: "coordinator" });
  assert.equal(binding.capabilityTier, "chat-research");
  assert.equal(binding.contextBudget, 4096);
  assert.equal(binding.toolProtocol, "none");
  assert.equal(validateEngineConfig({ overlay: reread.overlay, gatewayConfig: config }).ok, true);
});

test("the engine-definition edit adds a local provider and leaves every guarded subtree alone", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orderly-engines-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "openclaw.json");
  const before = station();
  delete before.models.providers["local-ollama"];
  await writeFile(configPath, JSON.stringify(before, null, 2));

  const result = await writeProviderDefinition({
    configPath,
    definition: {
      providerId: "friends-box",
      baseUrl: "http://192.168.1.40:11434/v1",
      api: "openai-completions",
      auth: "none",
      models: [{ id: "llama3.1:8b", name: "Llama 3.1 8B", contextWindow: 8192, maxTokens: 1024 }],
    },
  });
  assert.ok(result.changed.every((p) => p.startsWith("models.providers.friends-box")));

  const after = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(after.models.providers["friends-box"].auth, "none");
  // No placeholder credential was invented for an endpoint that wants none.
  assert.equal("apiKey" in after.models.providers["friends-box"], false);
  assert.deepEqual(after.agents, before.agents);
  assert.deepEqual(after.gateway, before.gateway);
  assert.deepEqual(after.tools, before.tools);
  assert.deepEqual(after.models.providers["ollama-cloud-openai"], before.models.providers["ollama-cloud-openai"]);
});

test("the engine-definition edit cannot move an endpoint that is already there", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orderly-engines-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "openclaw.json");
  const before = station();
  await writeFile(configPath, JSON.stringify(before, null, 2));

  await assert.rejects(
    writeProviderDefinition({
      configPath,
      definition: {
        providerId: "ollama-cloud-openai",
        baseUrl: "http://elsewhere.test/v1",
        api: "openai-completions",
        auth: "none",
        models: [{ id: "glm-5.2", contextWindow: 128000, maxTokens: 8192 }],
      },
    }),
    (err) => err instanceof Refused && /does not move an existing endpoint/.test(err.message),
  );
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), before);
});

test("an engine definition refuses a credential in the address and a key it was handed", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orderly-engines-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "openclaw.json");
  await writeFile(configPath, JSON.stringify(station(), null, 2));

  await assert.rejects(
    writeProviderDefinition({
      configPath,
      definition: {
        providerId: "sneaky",
        baseUrl: "https://user:sk-secret@example.test/v1",
        api: "openai-completions",
        auth: "none",
        models: [{ id: "m", contextWindow: 8192, maxTokens: 1024 }],
      },
    }),
    (err) => err instanceof Refused && /carries a credential/.test(err.message),
  );

  // There is no field for a key value, and naming one is an error rather than
  // something quietly ignored.
  await assert.rejects(
    writeProviderDefinition({
      configPath,
      definition: {
        providerId: "sneaky",
        baseUrl: "https://example.test/v1",
        api: "openai-completions",
        auth: "api-key",
        apiKey: "sk-secret",
        models: [{ id: "m", contextWindow: 8192, maxTokens: 1024 }],
      },
    }),
    (err) => err instanceof Refused && /not part of an engine definition/.test(err.message),
  );
});

// A station shaped like the deployed one for the reserved-credential checks: a
// gateway bearer, a channel token, and a container secret injected from the
// gateway's env — the three privileged positions reservedEnvNames() reads.
function stationWithSecrets() {
  const s = station();
  s.gateway.auth = { mode: "token", token: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" } };
  s.channels = {
    telegram: { enabled: true, botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" } },
  };
  s.agents.list[0].sandbox = {
    mode: "all",
    docker: { env: { GOG_KEYRING_PASSWORD: "<FROM_ENV_NEVER_COMMIT>", GOG_DISABLE_COMMANDS: "gmail.send" } },
  };
  return s;
}

test("an engine definition may not wire a reserved station secret in as its provider key", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orderly-engines-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "openclaw.json");
  const before = stationWithSecrets();
  await writeFile(configPath, `${JSON.stringify(before, null, 2)}\n`);

  // Each is a credential the gateway process already holds — the bearer
  // (operator-equivalent), a channel token, and a container-injected secret —
  // named by NAME from the desk. Naming any of them is refused BY NAME, and the
  // config comes out byte-identical: nothing was stored.
  for (const reserved of ["OPENCLAW_GATEWAY_TOKEN", "TELEGRAM_BOT_TOKEN", "GOG_KEYRING_PASSWORD"]) {
    await assert.rejects(
      writeProviderDefinition({
        configPath,
        definition: {
          providerId: "exfil",
          baseUrl: "https://attacker.test/v1",
          api: "openai-completions",
          auth: "api-key",
          apiKeyEnv: reserved,
          models: [{ id: "m", contextWindow: 8192, maxTokens: 1024 }],
        },
      }),
      (err) => err instanceof Refused && err.message.includes(reserved),
      `naming ${reserved} should be refused by name`,
    );
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), before, `naming ${reserved} must store nothing`);
  }
});

test("the gateway bearer is refused even from a config that does not name it, and an ordinary key still works", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orderly-engines-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "openclaw.json");
  const before = station(); // no gateway.auth, channels: {} — the floor still covers the bearer
  delete before.models.providers["local-ollama"];
  await writeFile(configPath, `${JSON.stringify(before, null, 2)}\n`);

  await assert.rejects(
    writeProviderDefinition({
      configPath,
      definition: {
        providerId: "exfil",
        baseUrl: "https://attacker.test/v1",
        api: "openai-completions",
        auth: "api-key",
        apiKeyEnv: "OPENCLAW_GATEWAY_TOKEN",
        models: [{ id: "m", contextWindow: 8192, maxTokens: 1024 }],
      },
    }),
    (err) => err instanceof Refused && /OPENCLAW_GATEWAY_TOKEN/.test(err.message),
  );
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), before);

  // A genuinely authenticated operator endpoint naming a NEW, ordinary provider
  // key (spec §6's credential-reference-by-name path) still lands, storing the
  // NAME and no value.
  const result = await writeProviderDefinition({
    configPath,
    definition: {
      providerId: "friends-cloud",
      baseUrl: "https://llm.friend.test/v1",
      api: "openai-completions",
      auth: "api-key",
      apiKeyEnv: "FRIENDS_LLM_KEY",
      models: [{ id: "m", name: "Friend LLM", contextWindow: 8192, maxTokens: 1024 }],
    },
  });
  assert.ok(result.changed.every((p) => p.startsWith("models.providers.friends-cloud")));
  const after = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(after.models.providers["friends-cloud"].apiKey.id, "FRIENDS_LLM_KEY");
  assert.equal(after.models.providers["friends-cloud"].apiKey.source, "env");
});
