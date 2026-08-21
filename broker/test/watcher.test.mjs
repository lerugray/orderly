import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { LaneRegistry } from "../registry.mjs";
import { LaneWatcher, classifyTerminal } from "../watcher.mjs";
import { fixtureRepo } from "./helpers.mjs";

const runFile = promisify(execFile);

test("watcher classification covers every contract terminal class", () => {
  assert.equal(
    classifyTerminal({ groupWasAlive: false, groupAlive: false, exitCode: 0, timedOut: false, gitChanged: true, stalled: false }),
    "exit-zero",
  );
  assert.equal(
    classifyTerminal({ groupWasAlive: false, groupAlive: false, exitCode: 3, timedOut: false, gitChanged: true, stalled: false }),
    "failed",
  );
  assert.equal(
    classifyTerminal({ groupWasAlive: false, groupAlive: false, exitCode: 124, timedOut: true, gitChanged: true, stalled: false }),
    "timed-out",
  );
  assert.equal(
    classifyTerminal({ groupWasAlive: true, groupAlive: true, exitCode: 0, timedOut: false, gitChanged: true, stalled: false }),
    "process-unclean",
  );
  assert.equal(
    classifyTerminal({ groupWasAlive: false, groupAlive: false, exitCode: 0, timedOut: false, gitChanged: false, stalled: false }),
    "no-op",
  );
  assert.equal(
    classifyTerminal({ groupWasAlive: false, groupAlive: false, exitCode: null, timedOut: false, gitChanged: false, stalled: true }),
    "failed",
  );
});

test("unchanged log plus dead process group is terminal failed with stall noted", async (t) => {
  const fixture = await fixtureRepo();
  t.after(fixture.cleanup);
  const root = join(fixture.root, "lanes");
  const registry = new LaneRegistry(root);
  await registry.load();
  const id = "stalled-lane";
  const laneDir = registry.laneDir(id);
  const workdir = join(laneDir, "worktree");
  await mkdir(laneDir, { recursive: true });
  await runFile("git", ["clone", "--quiet", fixture.repo, workdir]);
  const logPath = join(laneDir, "lane.log");
  await writeFile(logPath, "worker stopped talking token=supersecret Authorization: Bearer abc.def.ghi\n");
  await writeFile(join(laneDir, "brief.txt"), "fixture brief\n");
  await registry.putLane({
    id,
    repo_id: "fixture-sandbox",
    base_sha: fixture.sha,
    brief_sha256: "b".repeat(64),
    preset_id: "test",
    timeout_s: 60,
    state: "running",
    terminal_class: null,
    terminal_record: null,
    harvest: null,
    log_excerpt: null,
    created_ts: "2026-08-21T00:00:00.000Z",
    dispatched_ts: "2026-08-21T00:00:01.000Z",
    terminal_ts: null,
    runtime: {
      workdir,
      log_path: logPath,
      done_path: join(laneDir, "lane.done"),
      exit_path: join(laneDir, "lane.exit"),
      timeout_path: join(laneDir, "lane.timeout"),
      pgid: 999999,
    },
  });
  let clock = 1_000;
  const watcher = new LaneWatcher({
    registry,
    pollMs: 60_000,
    stallMs: 20 * 60 * 1000,
    stabilityMs: 0,
    alive: async () => false,
    now: () => clock,
  });
  t.after(() => watcher.close());
  await watcher.arm(id);
  clock += 20 * 60 * 1000 + 1;
  await watcher.check(id);
  const lane = registry.lane(id);
  assert.equal(lane.state, "terminal");
  assert.equal(lane.terminal_class, "failed");
  assert.match(lane.terminal_record.sweep_result, /^stall-detected;/);
  assert.equal(lane.terminal_record.git_status_stable, true);
  assert.ok(lane.harvest.patch_sha256);
  assert.doesNotMatch(lane.log_excerpt, /supersecret|abc\.def\.ghi/);
  assert.match(lane.log_excerpt, /\[REDACTED\]/);
});
