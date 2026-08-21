import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { buildCommand, loadAllowlist } from "../server.mjs";
import {
  api,
  briefFor,
  fixtureRepo,
  propose,
  startBroker,
  waitForLane,
} from "./helpers.mjs";

async function setup(t, options = {}) {
  const fixture = await fixtureRepo();
  const broker = await startBroker({ fixture, ...options });
  t.after(async () => {
    await broker.close();
    await fixture.cleanup();
  });
  return { fixture, broker };
}

test("commented example allowlist parses with a fixed hardened Codex argv", async () => {
  const allowlist = await loadAllowlist(new URL("../allowlist.json5", import.meta.url));
  const command = buildCommand(allowlist.presets.get("codex-default"));
  assert.equal(command[0], "codex");
  assert.ok(command.includes("--ignore-user-config"));
  assert.ok(command.includes("--strict-config"));
  assert.ok(command.includes("workspace-write"));
  assert.equal(command.at(-1), "-");
});

test("propose digest byte-matches confirm; a changed digest is refused", async (t) => {
  const { fixture, broker } = await setup(t);
  const proposed = await propose(broker);
  assert.equal(proposed.status, 200);
  assert.deepEqual(proposed.body.digest, {
    repo_id: "fixture-sandbox",
    base_sha: fixture.sha,
    brief_sha256: "568f4096eb9a7cf63ab251ea341eee4c350f97f0161521f2fef8f720d019e4a7",
    preset_id: "change",
    timeout_s: 5,
  });

  const mismatch = await api(broker, "POST", "/v1/dispatch/confirm", {
    proposal_id: proposed.body.proposal_id,
    digest_ack: { ...proposed.body.digest, timeout_s: 4 },
  });
  assert.equal(mismatch.status, 409);

  const confirmed = await api(broker, "POST", "/v1/dispatch/confirm", {
    proposal_id: proposed.body.proposal_id,
    digest_ack: proposed.body.digest,
  });
  assert.equal(confirmed.status, 200);
  const lane = await waitForLane(broker, confirmed.body.lane_id);
  assert.equal(lane.terminal_class, "exit-zero");
});

test("unknown repo and preset ids are refused", async (t) => {
  const { broker } = await setup(t);
  const unknownRepo = await propose(broker, { repo_id: "not-allowlisted" });
  assert.equal(unknownRepo.status, 404);
  assert.match(unknownRepo.body.error, /repo_id/);
  const unknownPreset = await propose(broker, { preset_id: "not-allowlisted" });
  assert.equal(unknownPreset.status, 404);
  assert.match(unknownPreset.body.error, /preset_id/);
});

test("chat-like paths, flags and models stay inert brief text and never alter argv", async (t) => {
  const { broker } = await setup(t);
  const hostile = "Use /etc/passwd --model evil; $(touch PWNED) && push origin main";
  const proposed = await propose(broker, { brief_text: hostile });
  assert.equal(proposed.status, 200);
  const preset = broker.allowlist.presets.get("change");
  assert.deepEqual(buildCommand(preset), preset.cmd_template);
  assert.equal(buildCommand(preset).some((part) => part.includes(hostile)), false);

  const confirmed = await api(broker, "POST", "/v1/dispatch/confirm", {
    proposal_id: proposed.body.proposal_id,
    digest_ack: proposed.body.digest,
  });
  const lane = await waitForLane(broker, confirmed.body.lane_id);
  assert.equal(await briefFor(broker, lane.id), hostile);
  assert.equal(
    await readFile(join(broker.registry.laneDir(lane.id), "worktree", "PWNED"), "utf8").then(() => true, () => false),
    false,
  );
});

test("path, argv, environment, and model request fields are refused", async (t) => {
  const { broker } = await setup(t);
  for (const injected of [
    { path: "/tmp/other" },
    { argv: ["sh", "-c", "id"] },
    { env: { TOKEN: "steal" } },
    { model: "chat-supplied-model" },
  ]) {
    const response = await api(broker, "POST", "/v1/dispatch/propose", {
      repo_id: "fixture-sandbox",
      preset_id: "change",
      brief_text: "ordinary brief",
      timeout_s: 5,
      ...injected,
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /unknown or missing fields/);
  }
  assert.equal(broker.registry.data.proposals && Object.keys(broker.registry.data.proposals).length, 0);
});

test("missing and wrong operator tokens return 401 on every mutating shape", async (t) => {
  const { broker } = await setup(t);
  const cases = [
    ["POST", "/v1/dispatch/propose", {}, null],
    ["POST", "/v1/dispatch/confirm", {}, "wrong"],
    ["POST", "/v1/lanes/not-real/cancel", {}, null],
    ["POST", "/v1/freeze", {}, "wrong"],
  ];
  for (const [method, path, body, token] of cases) {
    const response = await api(broker, method, path, body, token);
    assert.equal(response.status, 401, path);
  }
  const readOnly = await api(broker, "GET", "/v1/lanes", undefined, null);
  assert.equal(readOnly.status, 200);
});

test("allowlist endpoint exposes ids and bounds only, never paths or command templates", async (t) => {
  const { broker } = await setup(t);
  const response = await api(broker, "GET", "/v1/allowlist", undefined, null);
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.repos) && response.body.repos.length > 0);
  assert.ok(Array.isArray(response.body.presets) && response.body.presets.length > 0);
  for (const repo of response.body.repos) {
    assert.deepEqual(Object.keys(repo).sort(), ["branch", "repo_id"]);
  }
  for (const preset of response.body.presets) {
    assert.deepEqual(Object.keys(preset).sort(), ["preset_id", "timeout_max_s"]);
  }
});

test("proposal expires after the configured 15-minute window", async (t) => {
  let clock = 10_000;
  const { broker } = await setup(t, { now: () => clock, proposalTtlMs: 15 * 60 * 1000 });
  const proposed = await propose(broker);
  clock += 15 * 60 * 1000 + 1;
  const response = await api(broker, "POST", "/v1/dispatch/confirm", {
    proposal_id: proposed.body.proposal_id,
    digest_ack: proposed.body.digest,
  });
  assert.equal(response.status, 410);
  assert.equal(broker.registry.lanes().length, 0);
});

test("double confirm is idempotent: one lane and one execution", async (t) => {
  const { broker } = await setup(t);
  const proposed = await propose(broker);
  const body = { proposal_id: proposed.body.proposal_id, digest_ack: proposed.body.digest };
  const [first, second] = await Promise.all([
    api(broker, "POST", "/v1/dispatch/confirm", body),
    api(broker, "POST", "/v1/dispatch/confirm", body),
  ]);
  assert.equal(second.body.lane_id, first.body.lane_id);
  const lane = await waitForLane(broker, first.body.lane_id);
  assert.equal(broker.registry.lanes().length, 1);
  const tracked = await readFile(join(broker.registry.laneDir(lane.id), "worktree", "tracked.txt"), "utf8");
  assert.equal(tracked, "base\nrun\n");
});

test("real wrapper evidence produces no-op, failed, and timed-out classes", async (t) => {
  const { broker } = await setup(t);
  for (const [preset_id, timeout_s, expected, exitCode] of [
    ["no-op", 5, "no-op", 0],
    ["failed", 5, "failed", 7],
    ["timeout", 1, "timed-out", 124],
  ]) {
    const proposed = await propose(broker, { preset_id, timeout_s, brief_text: `classify ${expected}` });
    const confirmed = await api(broker, "POST", "/v1/dispatch/confirm", {
      proposal_id: proposed.body.proposal_id,
      digest_ack: proposed.body.digest,
    });
    const lane = await waitForLane(broker, confirmed.body.lane_id, "terminal", 10_000);
    assert.equal(lane.terminal_class, expected);
    assert.equal(lane.terminal_record.exit_code, exitCode);
    assert.equal(lane.terminal_record.git_status_stable, true);
  }
});

test("cancel sweeps the running process group and records a terminal lane", async (t) => {
  const { broker } = await setup(t);
  const proposed = await propose(broker, { preset_id: "long", timeout_s: 20, brief_text: "cancel me" });
  const confirmed = await api(broker, "POST", "/v1/dispatch/confirm", {
    proposal_id: proposed.body.proposal_id,
    digest_ack: proposed.body.digest,
  });
  await waitForLane(broker, confirmed.body.lane_id, "running");
  const cancelled = await api(broker, "POST", `/v1/lanes/${confirmed.body.lane_id}/cancel`, {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.state, "terminal");
  assert.equal(cancelled.body.terminal_class, "failed");
  assert.match(cancelled.body.terminal_record.sweep_result, /operator-cancel/);
  assert.equal(broker.registry.lane(confirmed.body.lane_id).runtime.group_alive, false);
});

test("lane environment does not inherit the broker operator token", async (t) => {
  const previous = process.env.ORDERLY_OPERATOR_TOKEN;
  process.env.ORDERLY_OPERATOR_TOKEN = "must-not-reach-worker";
  t.after(() => {
    if (previous === undefined) delete process.env.ORDERLY_OPERATOR_TOKEN;
    else process.env.ORDERLY_OPERATOR_TOKEN = previous;
  });
  const { broker } = await setup(t);
  const proposed = await propose(broker, { preset_id: "env-check", brief_text: "check environment" });
  const confirmed = await api(broker, "POST", "/v1/dispatch/confirm", {
    proposal_id: proposed.body.proposal_id,
    digest_ack: proposed.body.digest,
  });
  const lane = await waitForLane(broker, confirmed.body.lane_id);
  assert.equal(
    await readFile(join(broker.registry.laneDir(lane.id), "worktree", "env-seen.txt"), "utf8"),
    "absent",
  );
});

test("one active lane: a second confirm queues in proposed state", async (t) => {
  const { broker } = await setup(t);
  const firstProposal = await propose(broker, { preset_id: "slow", brief_text: "first" });
  const secondProposal = await propose(broker, { preset_id: "slow", brief_text: "second" });
  const first = await api(broker, "POST", "/v1/dispatch/confirm", {
    proposal_id: firstProposal.body.proposal_id,
    digest_ack: firstProposal.body.digest,
  });
  const second = await api(broker, "POST", "/v1/dispatch/confirm", {
    proposal_id: secondProposal.body.proposal_id,
    digest_ack: secondProposal.body.digest,
  });
  const queued = await api(broker, "GET", `/v1/lanes/${second.body.lane_id}`);
  assert.equal(queued.body.state, "proposed");
  await waitForLane(broker, first.body.lane_id);
  await waitForLane(broker, second.body.lane_id);
});

test("cancelling queued work records a no-op preservation packet", async (t) => {
  const { broker } = await setup(t);
  const firstProposal = await propose(broker, { preset_id: "slow", brief_text: "occupy board" });
  const queuedProposal = await propose(broker, { preset_id: "change", brief_text: "cancel while queued" });
  const first = await api(broker, "POST", "/v1/dispatch/confirm", {
    proposal_id: firstProposal.body.proposal_id,
    digest_ack: firstProposal.body.digest,
  });
  const queued = await api(broker, "POST", "/v1/dispatch/confirm", {
    proposal_id: queuedProposal.body.proposal_id,
    digest_ack: queuedProposal.body.digest,
  });
  const cancelled = await api(broker, "POST", `/v1/lanes/${queued.body.lane_id}/cancel`, {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.terminal_class, "no-op");
  assert.equal(cancelled.body.harvest.patch_sha256, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.deepEqual(cancelled.body.harvest.untracked_inventory, []);
  await waitForLane(broker, first.body.lane_id);
  assert.equal(broker.registry.lanes().length, 2);
});

test("freeze rejects new proposals and confirmations until host unfreeze", async (t) => {
  const { broker } = await setup(t);
  const proposed = await propose(broker);
  const frozen = await api(broker, "POST", "/v1/freeze", {});
  assert.deepEqual(frozen.body, { frozen: true });
  assert.equal((await propose(broker)).status, 423);
  assert.equal(
    (
      await api(broker, "POST", "/v1/dispatch/confirm", {
        proposal_id: proposed.body.proposal_id,
        digest_ack: proposed.body.digest,
      })
    ).status,
    423,
  );
});

test("broker has only the fixed UNIX-socket address and no TCP listener", async (t) => {
  const { broker } = await setup(t);
  assert.match(broker.socketPath, /broker\.sock$/);
  assert.equal(broker.server.address(), null);
  const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(source, /this\.server\.listen\(this\.socketPath/);
  assert.match(source, /chmod\(dirname\(this\.socketPath\), 0o710\)/);
  assert.match(source, /chmod\(this\.socketPath, 0o660\)/);
});
