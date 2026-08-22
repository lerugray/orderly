#!/usr/bin/env node
// Isolated deployment-host acceptance probe. It creates a temporary OpenClaw
// state/config, a local no-auth model stub, and one real Docker sandbox using
// the compiled named-isolated profile. It never reads or writes the live config,
// state, sessions, credentials, or containers.

import { execFile as execFileCallback } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createAgent, readManifest } from "../../web/agents.mjs";
import { namedIsolatedProfile } from "../profile.mjs";
import { runContainerProbes } from "../probes.mjs";

const execFile = promisify(execFileCallback);
const openclaw = process.env.ORDERLY_TEST_OPENCLAW || "openclaw";
const docker = process.env.ORDERLY_TEST_DOCKER || "docker";
const memoryPolicy = process.env.ORDERLY_TEST_MEMORY_POLICY || "persistent";
if (!new Set(["persistent", "memoryless"]).has(memoryPolicy)) throw new Error("ORDERLY_TEST_MEMORY_POLICY must be persistent or memoryless");

function fakeModel() {
  let calls = 0;
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      const body = JSON.stringify({ object: "list", data: [{ id: "v041-probe", object: "model" }] });
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
      return res.end(body);
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls += 1;
    const toolResult = JSON.stringify({
      id: "chatcmpl-v041-tool",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "v041-probe",
      choices: [{
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_v041_probe",
            type: "function",
            function: { name: "exec", arguments: JSON.stringify({ command: "printf orderly-container-ready" }) },
          }],
        },
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const final = JSON.stringify({
      id: "chatcmpl-v041-ready",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "v041-probe",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ready" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const response = calls === 1 ? toolResult : final;
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(response) });
    res.end(response);
  });
  return {
    async listen() {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      return server.address().port;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const dir = await mkdtemp(join(tmpdir(), "v041-test-"));
const root = join(dir, "orderly");
const stateDir = join(dir, "openclaw-state");
const configPath = join(dir, "openclaw.json");
let agentId = null;
const model = fakeModel();

try {
  const port = await model.listen();
  const made = await createAgent({ root, fields: { name: "V041 Container Probe", memoryPolicy } });
  agentId = made.id;
  const record = (await readManifest(root)).agents[0];
  const config = {
    gateway: { mode: "local", bind: "loopback" },
    models: { providers: { "v041-local": {
      baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", auth: "api-key",
      apiKey: { source: "env", provider: "default", id: "V041_TEST_KEY" },
      models: [{ id: "v041-probe", name: "V041 probe", input: ["text"], contextWindow: 8192, maxTokens: 1024 }],
    } } },
    agents: {
      defaults: {
        workspace: join(dir, "default-workspace"),
        model: { primary: "v041-local/v041-probe", fallbacks: [] },
        sandbox: { mode: "all", backend: "docker", scope: "agent" },
        skills: [],
      },
      list: [namedIsolatedProfile({ root, record })],
    },
    tools: {
      profile: "minimal",
      alsoAllow: ["exec", "read", "write", "edit"],
      elevated: { enabled: false, allowFrom: {} },
      deny: ["process", "apply_patch", "browser", "canvas", "computer"],
      sandbox: { tools: { alsoAllow: ["exec", "read", "write", "edit"] } },
    },
    channels: {},
    bindings: [],
    browser: { enabled: false, evaluateEnabled: false },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const env = { ...process.env, V041_TEST_KEY: "local-test-only", OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: stateDir };
  await execFile(openclaw, ["config", "validate"], { env, timeout: 30_000, maxBuffer: 256 * 1024 });
  await execFile(openclaw, [
    "agent", "--local", "--agent", agentId,
    "--message", "Run the activation check with exec, then answer ready.",
    "--timeout", "120", "--json",
  ], { env, timeout: 150_000, maxBuffer: 512 * 1024 });
  const listed = await execFile(openclaw, ["sandbox", "list", "--json"], { env, timeout: 30_000, maxBuffer: 256 * 1024 });
  const containers = JSON.parse(listed.stdout).containers.filter((item) => item.sessionKey === `agent:${agentId}`);
  if (containers.length !== 1) throw new Error(`expected one temporary sandbox, found ${containers.length}`);
  const result = await runContainerProbes({ record, container: containers[0], dockerBin: docker });
  process.stdout.write(`${JSON.stringify({
    verdict: result.evidence.checks.every((check) => check.ok) ? "pass" : "fail",
    profile: "named-isolated",
    memoryPolicy,
    agentId,
    container: containers[0].containerName,
    configHash: containers[0].configHash,
    checkedAt: result.evidence.checkedAt,
    checks: result.evidence.checks,
    raw: result.raw,
  }, null, 2)}\n`);
  if (!result.evidence.checks.every((check) => check.ok)) process.exitCode = 1;
} finally {
  await model.close().catch(() => {});
  if (agentId) {
    const env = { ...process.env, V041_TEST_KEY: "local-test-only", OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: stateDir };
    await execFile(openclaw, ["sandbox", "recreate", "--agent", agentId, "--force"], { env, timeout: 30_000 }).catch(() => {});
    const names = await execFile(docker, ["ps", "-a", "--filter", `name=openclaw-sbx-agent-${agentId}-`, "--format", "{{.Names}}"], { timeout: 15_000 })
      .then((result) => result.stdout.trim().split(/\s+/).filter(Boolean), () => []);
    for (const name of names) await execFile(docker, ["rm", "-f", name], { timeout: 15_000 }).catch(() => {});
  }
  await rm(dir, { recursive: true, force: true });
}
