import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LaneRegistry, atomicWriteJson } from "../registry.mjs";

test("registry writes are atomic and leave no temporary file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orderly-registry-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "state", "registry.json");
  await atomicWriteJson(path, { version: 1, marker: "complete" });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1, marker: "complete" });
  assert.deepEqual((await readdir(join(root, "state"))).filter((name) => name.includes(".tmp-")), []);
});

test("boot reconciliation marks dead running lanes process-unclean and returns live lanes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orderly-registry-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new LaneRegistry(root);
  await registry.load();
  const base = {
    repo_id: "fixture-sandbox",
    base_sha: "a".repeat(40),
    brief_sha256: "b".repeat(64),
    preset_id: "codex-default",
    timeout_s: 60,
    state: "running",
    terminal_class: null,
    terminal_record: null,
    harvest: null,
    log_excerpt: null,
    created_ts: "2026-08-21T00:00:00.000Z",
    dispatched_ts: "2026-08-21T00:00:01.000Z",
    terminal_ts: null,
  };
  await registry.putLane({ id: "dead", ...base, runtime: { pgid: 111 } });
  await registry.putLane({ id: "live", ...base, runtime: { pgid: 222 } });
  const result = await registry.reconcile(async (pgid) => pgid === 222, () => "2026-08-21T00:01:00.000Z");
  assert.deepEqual(result, { live: ["live"], dead: ["dead"] });
  assert.equal(registry.lane("dead").state, "terminal");
  assert.equal(registry.lane("dead").terminal_class, "process-unclean");
  assert.deepEqual(registry.lane("dead").terminal_record, {
    exit_code: null,
    sweep_result: "process-group-absent-on-boot",
    git_status_stable: false,
  });
  assert.equal(registry.lane("live").state, "running");

  const reloaded = new LaneRegistry(root);
  await reloaded.load();
  assert.equal(reloaded.lane("dead").terminal_class, "process-unclean");
});
