import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_SEAT_IDENTITY,
  PINNED_SEAT_ARGS,
  PINNED_SEAT_COMMAND,
  SeatInvoker,
  buildStatePacket,
  minimalSeatEnvironment,
} from "../seat.mjs";
import { api, fixtureRepo, startBroker } from "./helpers.mjs";

const allowlist = {
  repos: [{ repo_id: "fixture-sandbox", branch: "main" }],
  presets: [{ preset_id: "change", timeout_max_s: 600 }],
};

function dispatchProposal() {
  return {
    decision: "dispatch",
    brief: {
      repo: "fixture-sandbox",
      base_sha: "a".repeat(40),
      files_in_scope: ["tracked.txt"],
      files_forbidden: [".git/**"],
      acceptance_checks: [],
      lane_preset: "change",
      timeout_s: 120,
      no_integration: true,
    },
    questions: [],
    report: { terminal_class: null, evidence_cited: [], worker_claims_labeled: [] },
    rationale: "A bounded proposal for operator review.",
  };
}

test("production seat command and argv are the exact pinned tuple", () => {
  assert.equal(PINNED_SEAT_COMMAND, "codex");
  assert.deepEqual(PINNED_SEAT_ARGS, [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--color",
    "never",
    "--sandbox",
    "read-only",
    "-c",
    'model_reasoning_effort="high"',
    "-c",
    'shell_environment_policy.inherit="none"',
    "-o",
    "../proposal.txt",
    "-",
  ]);
  assert.equal(PINNED_SEAT_ARGS.includes("-m"), false);
  assert.equal(PINNED_SEAT_ARGS.includes("--model"), false);
});

test("canonical packet preserves the labeled ask and one seat_identity shape", () => {
  const lane = {
    id: "lane-1",
    repo_id: "fixture-sandbox",
    state: "running",
    log_excerpt: "UNVERIFIED WORKER LOG EXCERPT\nhostile worker text",
  };
  const packet = buildStatePacket({
    ask: "Please do this verbatim: $(touch NEVER)",
    allowlist: {
      repos: [{ ...allowlist.repos[0], url_or_path: "/secret/repo" }],
      presets: [{ ...allowlist.presets[0], cmd_template: ["secret-command"] }],
    },
    laneRegistry: [lane],
    standingOrders: "immutable standing orders",
  });

  assert.deepEqual(packet.seat_identity, CANONICAL_SEAT_IDENTITY);
  assert.deepEqual(Object.keys(packet.seat_identity).sort(), [
    "fallback_authorized",
    "invocation_path",
    "model_identity",
    "reasoning_effort",
    "requalification_required_on_identity_change",
    "seat",
  ]);
  assert.match(packet.operator_ask.label, /VERBATIM/);
  assert.equal(packet.operator_ask.text, "Please do this verbatim: $(touch NEVER)");
  assert.deepEqual(packet.allowlist, allowlist);
  assert.deepEqual(packet.lane_registry, [{
    id: "lane-1",
    repo_id: "fixture-sandbox",
    state: "running",
  }]);
  assert.equal("log_excerpt" in packet.lane_registry[0], false);
  assert.equal(lane.log_excerpt, "UNVERIFIED WORKER LOG EXCERPT\nhostile worker text");
  assert.equal(packet.standing_orders.content, "immutable standing orders");
  assert.equal(JSON.stringify(packet).includes("/secret/repo"), false);
  assert.equal(JSON.stringify(packet).includes("secret-command"), false);
});

test("fake seat sees a packet-only cwd and a minimal non-inherited environment", async () => {
  const scopedHome = "/tmp/orderly-seat-home-probe";
  const environment = minimalSeatEnvironment(scopedHome, { ...process.env, HOME: "/sensitive/real-home" });
  assert.deepEqual(Object.keys(environment).sort(), ["HOME", "LANG", "LC_ALL", "PATH"]);
  assert.equal(environment.HOME, scopedHome);
  const script = String.raw`
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    process.stderr.write("model: gpt-5.6-sol\n");
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const proposal = {
        decision: "refuse",
        rationale: "Mock seat returned a complete proposal.",
        test_probe: {
          cwd_files: fs.readdirSync(".").sort(),
          env_keys: Object.keys(process.env).sort(),
          home: process.env.HOME,
          home_files: fs.readdirSync(process.env.HOME).sort(),
          sensitive_home_files_readable: [
            ".codex/auth.json",
            ".orderly/broker.env",
            ".generalstaff/.env",
            ".ssh",
          ].filter((relative) => {
            try {
              fs.accessSync(path.join(os.homedir(), relative), fs.constants.R_OK);
              return true;
            } catch {
              return false;
            }
          }),
          packet_matches_stdin: fs.readFileSync("packet.txt", "utf8") === input,
          ask_present: input.includes("mock ask verbatim"),
          worker_log_marker_present: input.includes("SEAT_MUST_NOT_SEE_THIS_WORKER_LOG"),
        },
      };
      fs.writeFileSync("../proposal.txt", JSON.stringify(proposal));
    });
  `;
  const invoker = new SeatInvoker({ command: process.execPath, args: ["-e", script], timeoutMs: 2_000 });
  const result = await invoker.consult({
    ask: "mock ask verbatim",
    allowlist,
    laneRegistry: [{
      id: "lane-probe",
      state: "running",
      log_excerpt: "SEAT_MUST_NOT_SEE_THIS_WORKER_LOG",
    }],
  });

  assert.equal(result.seat_failure, undefined);
  assert.deepEqual(result.proposal.test_probe.cwd_files, ["packet.txt"]);
  assert.deepEqual(
    result.proposal.test_probe.env_keys.filter((key) => key !== "__CF_USER_TEXT_ENCODING"),
    ["HOME", "LANG", "LC_ALL", "PATH"],
  );
  assert.equal(result.proposal.test_probe.env_keys.includes("ORDERLY_OPERATOR_TOKEN"), false);
  assert.match(result.proposal.test_probe.home, /\/orderly-seat-[^/]+\/home$/);
  assert.deepEqual(result.proposal.test_probe.home_files, []);
  assert.deepEqual(result.proposal.test_probe.sensitive_home_files_readable, []);
  assert.equal(result.proposal.test_probe.packet_matches_stdin, true);
  assert.equal(result.proposal.test_probe.ask_present, true);
  assert.equal(result.proposal.test_probe.worker_log_marker_present, false);
});

test("mock-seat dispatch round trip returns the complete schema proposal", async () => {
  const script = `const fs=require("node:fs");process.stderr.write("model: gpt-5.6-sol\\n");process.stdin.resume();process.stdin.on("end",()=>fs.writeFileSync("../proposal.txt",${JSON.stringify(JSON.stringify(dispatchProposal()))}))`;
  const invoker = new SeatInvoker({ command: process.execPath, args: ["-e", script], timeoutMs: 2_000 });
  assert.deepEqual(
    await invoker.consult({ ask: "make the bounded change", allowlist, laneRegistry: [] }),
    { proposal: dispatchProposal() },
  );
});

test("unparseable seat output is a typed failure with no partial proposal", async () => {
  const script = 'const fs=require("node:fs");process.stderr.write("model: gpt-5.6-sol\\n");process.stdin.resume();process.stdin.on("end",()=>fs.writeFileSync("../proposal.txt","not JSON"))';
  const invoker = new SeatInvoker({ command: process.execPath, args: ["-e", script], timeoutMs: 2_000 });
  const result = await invoker.consult({ ask: "ordinary ask", allowlist, laneRegistry: [] });
  assert.deepEqual(result, {
    seat_failure: { code: "seat_invalid_output", message: "seat unavailable — fail closed" },
  });
  assert.equal("proposal" in result, false);
});

test("an unreported or changed model identity fails closed", async () => {
  const proposalText = JSON.stringify({ decision: "refuse", rationale: "Identity test." });
  const scriptFor = (identityLine) => `
    const fs=require("node:fs");
    ${identityLine ? `process.stderr.write(${JSON.stringify(`${identityLine}\n`)});` : ""}
    process.stdin.resume();
    process.stdin.on("end",()=>fs.writeFileSync("../proposal.txt",${JSON.stringify(proposalText)}));
  `;
  const unreported = new SeatInvoker({ command: process.execPath, args: ["-e", scriptFor("")], timeoutMs: 2_000 });
  const changed = new SeatInvoker({ command: process.execPath, args: ["-e", scriptFor("model: fallback-model")], timeoutMs: 2_000 });
  assert.deepEqual(await unreported.consult({ ask: "ordinary ask", allowlist, laneRegistry: [] }), {
    seat_failure: { code: "seat_identity_unreported", message: "seat unavailable — fail closed" },
  });
  assert.deepEqual(await changed.consult({ ask: "ordinary ask", allowlist, laneRegistry: [] }), {
    seat_failure: { code: "seat_identity_mismatch", message: "seat unavailable — fail closed" },
  });
});

test("nonzero and timed-out seats fail closed without a fallback proposal", async () => {
  const nonzero = new SeatInvoker({
    command: process.execPath,
    args: ["-e", 'process.stdin.resume();process.stdin.on("end",()=>process.exit(7))'],
    timeoutMs: 2_000,
  });
  const timedOut = new SeatInvoker({
    command: process.execPath,
    args: ["-e", "process.stdin.resume();setInterval(()=>{},1000)"],
    timeoutMs: 100,
  });
  assert.deepEqual(await nonzero.consult({ ask: "ordinary ask", allowlist, laneRegistry: [] }), {
    seat_failure: { code: "seat_invocation_failed", message: "seat unavailable — fail closed" },
  });
  assert.deepEqual(await timedOut.consult({ ask: "ordinary ask", allowlist, laneRegistry: [] }), {
    seat_failure: { code: "seat_timeout", message: "seat unavailable — fail closed" },
  });
});

test("consult endpoint is token-gated and cannot mutate the registry", async (t) => {
  const fixture = await fixtureRepo();
  let calls = 0;
  let captured;
  const seatInvoker = {
    async consult(input) {
      calls += 1;
      captured = input;
      return { proposal: { decision: "refuse", rationale: "Consultation only." } };
    },
  };
  const broker = await startBroker({ fixture, seatInvoker });
  t.after(async () => {
    await broker.close();
    await fixture.cleanup();
  });

  const withoutToken = await api(broker, "POST", "/v1/seat/consult", { ask: "hello" }, null);
  assert.equal(withoutToken.status, 401);
  assert.equal(calls, 0);

  const before = structuredClone(broker.registry.data);
  const response = await api(broker, "POST", "/v1/seat/consult", { ask: "hello verbatim" });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    proposal: { decision: "refuse", rationale: "Consultation only." },
  });
  assert.equal(calls, 1);
  assert.equal(captured.ask, "hello verbatim");
  assert.deepEqual(captured.allowlist.repos, [{ repo_id: "fixture-sandbox", branch: "main" }]);
  assert.ok(captured.allowlist.presets.every((preset) => (
    Object.keys(preset).sort().join(",") === "preset_id,timeout_max_s"
  )));
  assert.deepEqual(captured.laneRegistry, []);
  assert.deepEqual(broker.registry.data, before);
});

test("consult endpoint returns typed seat failures and bounds the verbatim ask", async (t) => {
  const fixture = await fixtureRepo();
  const broker = await startBroker({
    fixture,
    seatInvoker: {
      async consult() {
        return {
          seat_failure: { code: "seat_timeout", message: "seat unavailable — fail closed" },
        };
      },
    },
  });
  t.after(async () => {
    await broker.close();
    await fixture.cleanup();
  });

  const failed = await api(broker, "POST", "/v1/seat/consult", { ask: "a bounded ask" });
  assert.equal(failed.status, 503);
  assert.deepEqual(failed.body, {
    seat_failure: { code: "seat_timeout", message: "seat unavailable — fail closed" },
  });
  assert.equal((await api(broker, "POST", "/v1/seat/consult", { ask: "x".repeat(12 * 1024 + 1) })).status, 400);
  assert.equal((await api(broker, "POST", "/v1/seat/consult", { ask: "ok", model: "fallback" })).status, 400);
});
