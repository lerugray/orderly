// End to end: a seat configured to a small model on the operator's own box,
// and a real conversation through the real front door.
//
// Three processes, none of them a model: the front door is this repo's actual
// server.mjs, spawned; the gateway is a stand-in that resolves the seat with
// this repo's actual resolver and forwards; the endpoint is an OpenAI-compatible
// stand-in answering on loopback. What that proves is the thing worth proving —
// that a local endpoint configured this way is reached, answered by, and
// disclosed, all the way from the browser's POST to the words coming back.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startMockEngine, startStandInGateway } from "./engine-mocks.mjs";

const WEB = resolve(fileURLToPath(import.meta.url), "..", "..");
const TOKEN = "test-gateway-token";

function waitForServer(child) {
  return new Promise((ready, fail) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => fail(new Error(`front door did not listen\n${stdout}\n${stderr}`)), 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.stdout.on("data", (c) => {
      stdout += c;
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
      if (!match) return;
      clearTimeout(timeout);
      ready(Number(match[1]));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      fail(new Error(`front door exited before listening (${code ?? signal})\n${stderr}`));
    });
  });
}

function stationConfig(localBaseUrl) {
  return {
    gateway: { mode: "local", port: 18789, reload: { mode: "hybrid" } },
    channels: {},
    bindings: [],
    browser: { enabled: false },
    tools: { deny: ["browser"], elevated: { enabled: false } },
    commands: { ownerAllowFrom: ["telegram:1"] },
    meta: {},
    models: {
      mode: "merge",
      providers: {
        "local-ollama": {
          baseUrl: localBaseUrl,
          api: "openai-completions",
          auth: "none",
          timeoutSeconds: 120,
          models: [
            { id: "llama3.1:8b", name: "Llama 3.1 8B", input: ["text"], contextWindow: 8192, maxTokens: 1024 },
          ],
        },
      },
    },
    agents: {
      defaults: {
        workspace: "~/.openclaw/workspace",
        model: { primary: "local-ollama/llama3.1:8b" },
        sandbox: { mode: "all", backend: "docker" },
      },
      list: [{ id: "coordinator", sandbox: { mode: "all" } }, { id: "mail", sandbox: { mode: "all" } }],
    },
  };
}

async function stand(t, { classify = true } = {}) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "orderly-seat-e2e-")));
  const home = join(scratch, "home");
  await mkdir(join(home, ".openclaw"), { recursive: true });
  await mkdir(join(home, ".orderly"), { recursive: true });
  t.after(() => rm(scratch, { recursive: true, force: true }));

  const engine = await startMockEngine({ reply: "Tuesday is clear after two." });
  t.after(() => engine.close());

  const configPath = join(home, ".openclaw", "openclaw.json");
  const enginesPath = join(home, ".orderly", "engines.json");
  await writeFile(configPath, JSON.stringify(stationConfig(engine.baseUrl), null, 2));
  if (classify) {
    await writeFile(
      enginesPath,
      JSON.stringify(
        {
          version: 1,
          models: { "local-ollama/llama3.1:8b": { toolProtocol: "none", tiers: ["chat-research"] } },
          seats: { defaults: { capabilityTier: "chat-research", contextBudget: 6000 } },
        },
        null,
        2,
      ),
    );
  }

  const gateway = await startStandInGateway({ configPath, enginesPath, token: TOKEN });
  t.after(() => gateway.close());

  const child = spawn(process.execPath, [join(WEB, "server.mjs")], {
    cwd: WEB,
    env: {
      ...process.env,
      HOME: home,
      ORDERLY_WEB_PORT: "0",
      ORDERLY_GATEWAY_PORT: String(gateway.port),
      ORDERLY_CONFIG: configPath,
      ORDERLY_ENGINES_CONFIG: enginesPath,
      ORDERLY_QUEUE_STATE: join(scratch, "queue-state.json"),
      OPENCLAW_GATEWAY_TOKEN: TOKEN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  });
  const port = await waitForServer(child);
  return { port, engine, gateway, enginesPath, configPath, home };
}

test("a desk pointed at a local endpoint really converses with it, and says which engine answered", async (t) => {
  const { port, engine, gateway } = await stand(t);

  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      desk: "coordinator",
      thread: "abcd1234",
      stream: false,
      messages: [{ role: "user", content: "What does Tuesday look like?" }],
    }),
  });
  assert.equal(res.status, 200);

  const reply = (await res.json())?.choices?.[0]?.message?.content;
  assert.equal(reply, "Tuesday is clear after two.");
  // The words came from the endpoint on loopback, not from anything in between.
  assert.equal(engine.calls.completions, 1);
  assert.equal(gateway.seen.models[0], "openclaw/coordinator");

  // §2.5.2 — the engine and tier ride with the answer, so a surface never has
  // to guess which model just spoke.
  assert.equal(res.headers.get("x-orderly-engine"), "local-ollama/llama3.1:8b");
  assert.equal(res.headers.get("x-orderly-tier"), "chat-research");
});

test("the streamed path carries the same endpoint's words and the same disclosure", async (t) => {
  const { port, engine } = await stand(t);

  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      desk: "coordinator",
      thread: "abcd1234",
      stream: true,
      messages: [{ role: "user", content: "And Wednesday?" }],
    }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-orderly-tier"), "chat-research");
  const body = await res.text();
  assert.match(body, /Tuesday is clear after two\./);
  assert.equal(engine.calls.completions, 1);
});

test("an unclassified station chats exactly as it did before any of this existed", async (t) => {
  const { port } = await stand(t, { classify: false });

  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      desk: "coordinator",
      thread: "abcd1234",
      stream: false,
      messages: [{ role: "user", content: "Still there?" }],
    }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json())?.choices?.[0]?.message?.content, "Tuesday is clear after two.");
  assert.equal(res.headers.get("x-orderly-tier"), "unclassified");
});

test("the engines readout discloses every seat and names the harness this build hasn't got", async (t) => {
  const { port } = await stand(t);

  const body = await (await fetch(`http://127.0.0.1:${port}/api/engines`)).json();
  assert.equal(body.configured, true);
  assert.deepEqual(body.problems, []);

  const coordinator = body.seats.find((s) => s.seat === "coordinator");
  assert.equal(coordinator.endpoint.startsWith("http://127.0.0.1:"), true);
  assert.equal(coordinator.model, "llama3.1:8b");
  assert.equal(coordinator.capabilityTier, "chat-research");
  assert.equal(coordinator.contextBudget, 6000);
  assert.equal(coordinator.toolProtocol, "none");
  assert.equal(coordinator.credentialRef, null);
  // Declared, unavailable, and said so — rather than omitted, which would read
  // as though chained tasks were simply not a thing.
  const harness = body.harnesses.find((h) => h.ref === "bounded-sequencer-v1");
  assert.equal(harness.available, false);
  assert.match(harness.note, /not built in this release/);
});

test("probing a seat from the desk reaches the endpoint and reports the stages", async (t) => {
  const { port, engine } = await stand(t);

  const res = await fetch(`http://127.0.0.1:${port}/api/engines/probe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seat: "coordinator" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true, body.message);
  assert.equal(body.model, "llama3.1:8b");
  assert.ok(body.stages.some((s) => s.stage === "model-tag" && s.ok));
  assert.equal(engine.calls.models, 1);
});

test("a probe of an endpoint that isn't there fails in plain English and changes nothing", async (t) => {
  const { port } = await stand(t);

  const res = await fetch(`http://127.0.0.1:${port}/api/engines/probe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      proposal: {
        providerId: "friends-box",
        baseUrl: "http://127.0.0.1:1/v1",
        api: "openai-completions",
        auth: "none",
        modelId: "llama3.1:8b",
        contextWindow: 8192,
        maxTokens: 1024,
      },
    }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.failedStage, "reachability");
  assert.match(body.retained, /Nothing was changed/);
});

test("a classification the station won't stand behind is refused, and the file is untouched", async (t) => {
  const { port, enginesPath } = await stand(t);
  const before = await readFile(enginesPath, "utf8");

  const res = await fetch(`http://127.0.0.1:${port}/api/engines`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seats: { coordinator: { capabilityTier: "coding-lane" } } }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /dispatch broker/);
  assert.equal(await readFile(enginesPath, "utf8"), before);
});

test("a good classification written through the desk takes effect on the next message", async (t) => {
  const { port, enginesPath } = await stand(t);

  const res = await fetch(`http://127.0.0.1:${port}/api/engines`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seats: { coordinator: { capabilityTier: "chat-research", contextBudget: 2048 } } }),
  });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const written = JSON.parse(await readFile(enginesPath, "utf8"));
  assert.equal(written.seats.coordinator.contextBudget, 2048);
  // The defaults classification the station started with is still there: a
  // seat edit is a seat edit.
  assert.equal(written.seats.defaults.contextBudget, 6000);
});

test("adding a whole engine definition probes it first and then writes the provider", async (t) => {
  const { port, configPath } = await stand(t);
  const second = await startMockEngine({ models: [{ id: "qwen2.5:7b" }], reply: "ok" });
  t.after(() => second.close());

  const res = await fetch(`http://127.0.0.1:${port}/api/engines`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: {
        providerId: "friends-box",
        baseUrl: second.baseUrl,
        api: "openai-completions",
        auth: "none",
        models: [{ id: "qwen2.5:7b", name: "Qwen 2.5 7B", contextWindow: 32768, maxTokens: 2048 }],
      },
    }),
  });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.equal(second.calls.completions, 1);

  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.models.providers["friends-box"].auth, "none");
  assert.equal(config.agents.defaults.model.primary, "local-ollama/llama3.1:8b");
});
