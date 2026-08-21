import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { readFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { brokerRoute, createBrokerProxy } from "../server.mjs";
import { digestJson, proposalPrefill } from "../public/orchestration-core.js";

const TEST_DIR = resolve(fileURLToPath(import.meta.url), "..");

class FakeResponse extends Writable {
  constructor() {
    super();
    this.headersSent = false;
    this.statusCode = null;
    this.chunks = [];
  }

  writeHead(statusCode) {
    this.statusCode = statusCode;
    this.headersSent = true;
    return this;
  }

  _write(chunk, _encoding, done) {
    this.chunks.push(Buffer.from(chunk));
    done();
  }
}

function replyingRequest(capture, responseBody = { proposal_id: "proposal-7", digest: {} }) {
  return (options) => {
    capture.options = options;
    const upstream = new EventEmitter();
    upstream.setTimeout = () => {};
    upstream.destroy = (error) => upstream.emit("error", error);
    upstream.end = (body) => {
      capture.body = body;
      const brokerResponse = Readable.from([JSON.stringify(responseBody)]);
      brokerResponse.statusCode = 200;
      setImmediate(() => upstream.emit("response", brokerResponse));
    };
    return upstream;
  };
}

function harness({ method = "POST", token, requestImpl, body = "{}" } = {}) {
  const result = { errors: [], json: [] };
  const handle = createBrokerProxy({
    socketPath: "/mock/broker.sock",
    sameOrigin: () => true,
    readBody: async () => body,
    jsonError: (_res, status, message) => result.errors.push({ status, message }),
    sendJson: (_res, status, payload) => result.json.push({ status, payload }),
    securityHeaders: () => {},
    requestImpl,
  });
  const req = { method, headers: token ? { "x-orderly-operator": token } : {} };
  const res = new FakeResponse();
  return { handle, req, res, result };
}

test("proxy forwards the operator header and body to the fixed broker verb", async () => {
  const capture = {};
  const token = "operator-secret-never-print";
  const requestBody = JSON.stringify({ repo_id: "orderly", preset_id: "codex-high" });
  const app = harness({ token, body: requestBody, requestImpl: replyingRequest(capture) });
  await app.handle(app.req, app.res, "/v1/dispatch/propose");
  await once(app.res, "finish");

  assert.equal(capture.options.socketPath, "/mock/broker.sock");
  assert.equal(capture.options.path, "/v1/dispatch/propose");
  assert.equal(capture.options.headers["X-Orderly-Operator"], token);
  assert.equal(capture.body, requestBody);
});

test("a tokenless mutation returns 401 before invoking the broker client", async () => {
  let brokerCalls = 0;
  const app = harness({
    requestImpl: () => {
      brokerCalls += 1;
      throw new Error("must not be reached");
    },
  });
  await app.handle(app.req, app.res, "/v1/dispatch/propose");
  assert.equal(brokerCalls, 0);
  assert.deepEqual(app.result.errors, [
    { status: 401, message: "An operator token is required for this action." },
  ]);
});

test("a tokenless seat consultation returns 401 before spending seat quota", async () => {
  let brokerCalls = 0;
  const app = harness({
    requestImpl: () => {
      brokerCalls += 1;
      throw new Error("must not be reached");
    },
    body: JSON.stringify({ ask: "consult the seat" }),
  });
  await app.handle(app.req, app.res, "/v1/seat/consult");
  assert.equal(brokerCalls, 0);
  assert.deepEqual(app.result.errors, [
    { status: 401, message: "An operator token is required for this action." },
  ]);
});

test("the rendered digest is the proposal response digest verbatim", () => {
  const proposal = {
    proposal_id: "proposal-7",
    digest: {
      repo_id: "orderly",
      base_sha: "0123456789abcdef",
      brief_sha256: "brief-hash",
      preset_id: "codex-high",
      timeout_s: 1800,
    },
  };
  assert.equal(digestJson(proposal), JSON.stringify(proposal.digest, null, 2));
});

test("broker-offline handling is explicit while the read-only page remains renderable", async () => {
  const app = harness({
    method: "GET",
    requestImpl: () => {
      throw Object.assign(new Error("missing socket"), { code: "ENOENT" });
    },
  });
  await app.handle(app.req, app.res, "/v1/lanes");
  assert.equal(app.result.json[0].status, 503);
  assert.equal(app.result.json[0].payload.broker.online, false);
  assert.match(app.result.json[0].payload.error, /broker is offline/i);

  const html = await readFile(resolve(TEST_DIR, "..", "public", "orchestration.html"), "utf8");
  assert.match(html, /Orchestration desk/);
  assert.match(html, /Checking broker/);
});

test("the operator token never appears in any server log line", async () => {
  const capture = {};
  const token = "grep-me-not-4f29d";
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts) => logs.push(parts.join(" "));
  console.error = (...parts) => logs.push(parts.join(" "));
  try {
    const app = harness({ token, requestImpl: replyingRequest(capture) });
    await app.handle(app.req, app.res, "/v1/dispatch/propose");
    await once(app.res, "finish");
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.equal(logs.join("\n").includes(token), false, `token leaked in logs:\n${logs.join("\n")}`);
});

test("only the contract's fixed verbs map through the browser prefix", () => {
  assert.equal(brokerRoute("GET", "/api/orchestration/v1/lanes/lane-1"), "/v1/lanes/lane-1");
  assert.equal(brokerRoute("POST", "/api/orchestration/v1/lanes/lane-1/cancel"), "/v1/lanes/lane-1/cancel");
  assert.equal(brokerRoute("POST", "/api/orchestration/v1/freeze"), "/v1/freeze");
  assert.equal(brokerRoute("POST", "/api/orchestration/v1/seat/consult"), "/v1/seat/consult");
  assert.equal(brokerRoute("POST", "/api/orchestration/v1/arbitrary"), null);
});

test("seat prefill returns only four bounded form fields and ignores executable-looking extras", () => {
  const proposal = {
    decision: "dispatch",
    model: "never-a-form-field",
    path: "/never-a-form-field",
    command: ["sh", "-c", "never-a-form-field"],
    brief: {
      repo: "orderly",
      base_sha: "a".repeat(40),
      files_in_scope: ["broker/seat.mjs"],
      files_forbidden: [".git/**"],
      acceptance_checks: [],
      lane_preset: "codex-default",
      timeout_s: 99_999,
      no_integration: true,
    },
  };
  const prefill = proposalPrefill(proposal, {
    repos: [{ repo_id: "orderly", branch: "main", url_or_path: "/not-for-the-desk" }],
    presets: [{ preset_id: "codex-default", timeout_max_s: 1800, cmd_template: ["not-for-the-desk"] }],
  });

  assert.deepEqual(Object.keys(prefill).sort(), ["brief_text", "preset_id", "repo_id", "timeout_s"]);
  assert.equal(prefill.repo_id, "orderly");
  assert.equal(prefill.preset_id, "codex-default");
  assert.equal(prefill.timeout_s, 1800);
  assert.equal(prefill.brief_text, JSON.stringify(proposal.brief, null, 2));
  assert.equal("model" in prefill, false);
  assert.equal("path" in prefill, false);
  assert.equal("command" in prefill, false);
});

test("seat prefill refuses invented repository or preset ids", () => {
  const base = {
    decision: "dispatch",
    brief: {
      repo: "invented-repo",
      lane_preset: "invented-preset",
      timeout_s: 300,
    },
  };
  const allowlist = {
    repos: [{ repo_id: "orderly", branch: "main" }],
    presets: [{ preset_id: "codex-default", timeout_max_s: 1800 }],
  };
  assert.equal(proposalPrefill(base, allowlist), null);
});

test("desk labels consultation as a non-executing proposal", async () => {
  const html = await readFile(resolve(TEST_DIR, "..", "public", "orchestration.html"), "utf8");
  assert.match(html, /Ask ORDERLY/);
  assert.match(html, /PROPOSAL — nothing runs until you confirm a digest/);
  assert.match(html, /Prefill dispatch form/);
});
