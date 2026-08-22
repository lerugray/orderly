import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAgent, CONTAINER_PROBES, readManifest, setLifecycle } from "../../web/agents.mjs";
import { agentRuntimeManage, agentRuntimeRoster } from "../../web/agent-runtime-client.mjs";
import { createAgentControl } from "../control.mjs";
import { readGatewayConfig, writeAgentEntry } from "../config.mjs";
import { namedIsolatedProfile, PROFILE_NAME } from "../profile.mjs";
import { runContainerProbes } from "../probes.mjs";
import { listenAgentRuntime } from "../service.mjs";

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), "orderly-v041-agents-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function stationConfig() {
  return {
    agents: {
      defaults: { sandbox: { mode: "all", backend: "docker", scope: "agent" } },
      list: [{ id: "coordinator", sandbox: { workspaceAccess: "rw" } }],
    },
    tools: { elevated: { enabled: false, allowFrom: {} } },
    channels: {},
    bindings: [],
  };
}

test("the compiled profile is separate, zero-network, derived, and memory-policy exact", async (t) => {
  const root = await scratch(t);
  const persistent = await createAgent({ root, fields: { name: "Reading Log" } });
  const manifest = await readManifest(root);
  const record = manifest.agents.find((item) => item.id === persistent.id);
  const profile = namedIsolatedProfile({ root, record });

  assert.equal(PROFILE_NAME, "named-isolated");
  assert.equal(profile.id, persistent.id);
  assert.deepEqual(profile.sandbox, {
    mode: "all", backend: "docker", scope: "agent", workspaceAccess: "rw",
    docker: {
      network: "none", readOnlyRoot: true, tmpfs: ["/tmp", "/var/tmp", "/run"], capDrop: ["ALL"], user: "1000:1000",
      binds: [
        `${join(root, "agents", persistent.id, "profile.json")}:/orderly/profile.json:ro`,
        `${join(root, "agents", persistent.id, "standing-orders.md")}:/orderly/standing-orders.md:ro`,
      ],
      dangerouslyAllowExternalBindSources: true,
    },
  });
  assert.equal(profile.workspace, join(root, "agents", persistent.id, "memory"));
  assert.ok(profile.tools.deny.includes("sessions_spawn"));
  assert.ok(profile.tools.deny.includes("web_fetch"));
  assert.deepEqual(profile.subagents.allowAgents, []);

  const memoryless = await createAgent({ root, fields: { name: "Scratch Pad", memoryPolicy: "memoryless" } });
  const memorylessRecord = (await readManifest(root)).agents.find((item) => item.id === memoryless.id);
  const zero = namedIsolatedProfile({ root, record: memorylessRecord });
  assert.equal(zero.sandbox.workspaceAccess, "none");
  assert.equal(zero.workspace, join(root, "agents", memoryless.id));
  assert.equal(zero.sandbox.docker.binds.some((bind) => bind.includes(":/workspace:")), false);
  assert.equal("setupCommand" in zero.sandbox.docker, false);
  assert.ok(zero.tools.deny.includes("write"));
  assert.throws(() => namedIsolatedProfile({ root, record, capabilitySockets: ["anything"] }), /no capability socket/);
});

test("gateway config edits append only the derived profile and retain policy gates", async (t) => {
  const dir = await scratch(t);
  const root = join(dir, "state");
  const configPath = join(dir, "openclaw.json");
  await writeFile(configPath, `${JSON.stringify(stationConfig(), null, 2)}\n`, { mode: 0o600 });
  const made = await createAgent({ root, fields: { name: "Reading Log" } });
  const record = (await readManifest(root)).agents[0];

  await writeAgentEntry({ configPath, root, record, validate: async () => true });
  const config = await readGatewayConfig(configPath);
  assert.equal(config.agents.list.length, 2);
  assert.deepEqual(config.agents.list[1], namedIsolatedProfile({ root, record }));
  assert.equal(config.tools.elevated.enabled, false);
  assert.equal(config.agents.defaults.sandbox.mode, "all");
  assert.equal((await stat(configPath)).mode & 0o077, 0);

  const weakened = stationConfig();
  weakened.tools.elevated.enabled = true;
  await writeFile(configPath, JSON.stringify(weakened));
  await assert.rejects(writeAgentEntry({ configPath, root, record, validate: async () => true }), /Elevated tools/);
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).agents.list.length, 1);
  assert.ok(made.id);
});

test("all compiled checks execute inside the one resolved OpenClaw container", async (t) => {
  const root = await scratch(t);
  const made = await createAgent({ root, fields: { name: "Reading Log" } });
  const record = (await readManifest(root)).agents[0];
  const container = {
    containerName: `openclaw-sbx-agent-${made.id}-abcd1234`,
    configHash: "f".repeat(64),
  };
  const calls = [];
  const result = await runContainerProbes({
    record,
    container,
    run: async (file, args) => { calls.push({ file, args }); return { stdout: "", stderr: "" }; },
  });
  assert.deepEqual(result.evidence.checks.map((check) => check.id), CONTAINER_PROBES.map((check) => check.id));
  assert.ok(result.evidence.checks.every((check) => check.ok));
  assert.equal(calls.length, CONTAINER_PROBES.length);
  assert.ok(calls.every((call) => call.file === "docker" && call.args[0] === "exec" && call.args[1] === container.containerName));
  assert.ok(calls.every((call) => call.args[2] === "sh" && call.args[3] === "-lc"));
});

test("the Unix-socket control path provisions, verifies, projects, suspends, and removes", async (t) => {
  const dir = await scratch(t);
  const root = join(dir, "state");
  const configPath = join(dir, "openclaw.json");
  const socketPath = join(dir, "runtime.sock");
  await writeFile(configPath, `${JSON.stringify(stationConfig(), null, 2)}\n`, { mode: 0o600 });
  let currentId = null;
  let containerPresent = true;
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args.slice(0, 3)]);
    if (file === "docker") return { stdout: "", stderr: "" };
    if (args[0] === "sandbox" && args[1] === "recreate") { containerPresent = false; return { stdout: "", stderr: "" }; }
    if (args[0] === "sandbox" && args[1] === "list") return {
      stdout: JSON.stringify({ containers: containerPresent && currentId ? [{
        containerName: `openclaw-sbx-agent-${currentId}-abcd1234`, backendId: "docker",
        sessionKey: `agent:${currentId}`, running: true, configHash: "a".repeat(64),
      }] : [] }),
      stderr: "",
    };
    throw new Error("unexpected fake runtime call");
  };
  const control = createAgentControl({ root, configPath, validate: async () => true, run });
  const runtime = await listenAgentRuntime({ socketPath, control, socketMode: 0o600 });
  t.after(() => runtime.close());

  const created = await agentRuntimeManage({ socketPath, action: "create", fields: { name: "Reading Log" } });
  currentId = created.agent.id;
  assert.equal(created.agent.lifecycle, "pending");
  assert.equal(created.agent.sandbox.verification.status, "owed");
  const active = await agentRuntimeManage({ socketPath, action: "activate", id: currentId });
  assert.equal(active.agent.lifecycle, "active");
  assert.equal(active.agent.sandbox.verification.status, "passed");
  assert.equal((await agentRuntimeRoster({ socketPath })).agents[0].sandbox.verification.checks.length, CONTAINER_PROBES.length);

  containerPresent = false;
  const reconciled = await agentRuntimeRoster({ socketPath });
  assert.equal(reconciled.agents[0].lifecycle, "pending", "a missing verified container cannot remain active");
  assert.equal(reconciled.agents[0].sandbox.verification.status, "owed");
  containerPresent = true;
  assert.equal((await agentRuntimeManage({ socketPath, action: "activate", id: currentId })).agent.lifecycle, "active");

  const suspended = await agentRuntimeManage({ socketPath, action: "lifecycle", id: currentId, lifecycle: "suspended" });
  assert.equal(suspended.agent.lifecycle, "suspended");
  assert.equal(containerPresent, false);
  await agentRuntimeManage({ socketPath, action: "lifecycle", id: currentId, lifecycle: "retired" });
  const removed = await agentRuntimeManage({ socketPath, action: "remove", id: currentId });
  assert.equal(removed.removed, true);
  assert.equal((await agentRuntimeRoster({ socketPath })).agents.length, 0);
  assert.ok(calls.some((call) => call[0] === "docker" && call[1] === "exec"));
});

test("a v0.4 active record is projected pending until v0.4.1 verification", async (t) => {
  const dir = await scratch(t);
  const root = join(dir, "state");
  const configPath = join(dir, "openclaw.json");
  await writeFile(configPath, `${JSON.stringify(stationConfig(), null, 2)}\n`);
  const made = await createAgent({ root, fields: { name: "Reading Log" } });
  const manifestPath = join(root, "identity-manifest.json");
  const old = JSON.parse(await readFile(manifestPath, "utf8"));
  old.agents[0].lifecycle = "active";
  old.agents[0].runtimeProfile = null;
  delete old.agents[0].containerVerification;
  await writeFile(manifestPath, `${JSON.stringify(old, null, 2)}\n`);

  const migratedRead = await readManifest(root);
  assert.equal(migratedRead.agents[0].lifecycle, "pending");
  assert.equal(migratedRead.agents[0].runtimeProfile, "named-isolated");
  assert.equal(migratedRead.agents[0].containerVerification.status, "owed");
  const control = createAgentControl({ root, configPath, validate: async () => true, run: async () => ({ stdout: "", stderr: "" }) });
  const migration = await control.migrate();
  assert.deepEqual(migration.agents, [{ id: made.id, lifecycle: "pending" }]);
  assert.equal((await readManifest(root)).agents[0].lifecycle, "pending");
});

test("migration never re-adds a retired runtime and permanent removal needs no stale container", async (t) => {
  const dir = await scratch(t);
  const root = join(dir, "state");
  const configPath = join(dir, "openclaw.json");
  await writeFile(configPath, `${JSON.stringify(stationConfig(), null, 2)}\n`);
  const made = await createAgent({ root, fields: { name: "Old Reading Log" } });
  await setLifecycle({ root, id: made.id, lifecycle: "retired" });
  const retired = (await readManifest(root)).agents[0];
  await writeAgentEntry({ configPath, root, record: retired, validate: async () => true });

  const run = async (_file, args) => {
    if (args[0] === "sandbox" && args[1] === "list") return { stdout: JSON.stringify({ containers: [] }), stderr: "" };
    throw new Error("retired migration tried to operate a nonexistent sandbox");
  };
  const control = createAgentControl({ root, configPath, validate: async () => true, run });
  const migration = await control.migrate();
  assert.deepEqual(migration.agents, [{ id: made.id, lifecycle: "retired" }]);
  assert.equal((await readGatewayConfig(configPath)).agents.list.some((entry) => entry.id === made.id), false);
  assert.deepEqual(await control.remove(made.id), { removed: true, id: made.id });
});
