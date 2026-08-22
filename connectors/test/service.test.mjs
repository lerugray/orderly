import assert from "node:assert/strict";
import test from "node:test";

import { createConnectorRequestHandler, dispatchConnectorCall, validateConnectorCall } from "../service.mjs";

function service(handlers) {
  return createConnectorRequestHandler({
    instanceId: "drive-ray",
    kindId: "google-drive",
    installedOperations: ["files.list", "files.read"],
    surface: "agent",
    handlers,
  });
}

const raw = (handler, body) => dispatchConnectorCall({ handler, body });

test("agent call envelope has a fixed route, fields, operation, and input keys", async () => {
  let calls = 0;
  const handler = service({
    "files.read": {
      inputKeys: ["fileId"],
      run: async ({ input }) => { calls += 1; return { title: `File ${input.fileId}` }; },
    },
  });
  const response = await raw(handler, { v: 1, operation: "files.read", requestId: "request-0001", input: { fileId: "abc" } });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.title, "File abc");
  assert.match(response.body.attribution, /untrusted data/);
  assert.match(response.body.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(calls, 1);

  const extraEnvelope = await raw(handler, { v: 1, operation: "files.read", requestId: "request-0002", input: { fileId: "abc" }, url: "https://example.test" });
  assert.equal(extraEnvelope.status, 400);
  const extraInput = await raw(handler, { v: 1, operation: "files.read", requestId: "request-0003", input: { fileId: "abc", command: "x" } });
  assert.equal(extraInput.status, 400);
  assert.equal(calls, 1, "a refused envelope never reached the adapter");
});

test("an uninstalled operation is refused before an adapter runs", () => {
  assert.throws(
    () => validateConnectorCall({
      kindId: "google-drive", installedOperations: ["files.read"], surface: "agent",
      body: { v: 1, operation: "files.list", requestId: "request-0001", input: {} },
    }),
    /not installed/,
  );
});

test("unknown surfaces and unguarded apply operations fail closed before an adapter runs", () => {
  const body = { v: 1, operation: "events.create.apply", requestId: "request-apply-1", input: {} };
  assert.throws(() => validateConnectorCall({
    kindId: "google-calendar-write",
    installedOperations: ["events.create.apply"],
    surface: "typo-that-would-bypass-agent",
    body,
  }), /Unknown connector service surface/);
  assert.throws(() => validateConnectorCall({
    kindId: "google-calendar-write",
    installedOperations: ["events.create.apply"],
    surface: "approval",
    body,
  }), /replay guard/);
});

test("adapter failures return a fixed message without provider detail", async () => {
  const handler = service({
    "files.read": {
      inputKeys: ["fileId"],
      run: async () => { throw new Error("provider response contains private material"); },
    },
  });
  const result = await raw(handler, { v: 1, operation: "files.read", requestId: "request-0001", input: { fileId: "abc" } });
  assert.equal(result.status, 502);
  assert.equal(result.body.error, "The connector adapter failed. No provider detail was exposed.");
});
