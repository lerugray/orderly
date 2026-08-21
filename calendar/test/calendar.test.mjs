// The helper's job is to be safe on its own terms, whatever is on the other
// end of the socket. These exercise the boundary directly — the argv it builds,
// the fields it refuses, the verbs it does not have — without listen(2) and
// without ever invoking Docker or gog.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CalendarRefused,
  addressFor,
  configuredAccounts,
  createEvent,
  createHandler,
  payloadOf,
  updateEvent,
} from "../server.mjs";

const ENV = { ORDERLY_GMAIL: "personal@example.com", ORDERLY_WORK_EMAIL: "work@example.net" };
const SCRIPT = "/opt/orderly/config/orderly-calendar.sh";

// A stand-in for execFile that records the argv instead of running anything.
function recorder(result = "{}") {
  const calls = [];
  const runner = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    cb(null, result, "");
  };
  return { calls, runner };
}

function failing(stderr, code = 2) {
  return (file, args, opts, cb) => {
    const err = new Error("exit");
    err.code = code;
    cb(err, "", stderr);
  };
}

const opts = (runner) => ({ env: ENV, script: SCRIPT, runner });

test("an account word with no address behind it is refused, not guessed", () => {
  assert.equal(addressFor("personal", ENV), "personal@example.com");
  assert.equal(addressFor("work", ENV), "work@example.net");
  assert.throws(() => addressFor("personal", {}), CalendarRefused);
  assert.throws(() => addressFor("work", { ORDERLY_WORK_EMAIL: "not-an-address" }), CalendarRefused);
});

test("only the two account words exist", () => {
  for (const bad of ["admin", "", null, "PERSONAL", "personal ", "../work"]) {
    assert.throws(() => addressFor(bad, ENV), CalendarRefused);
  }
  assert.deepEqual(configuredAccounts(ENV), { personal: true, work: true });
  assert.deepEqual(configuredAccounts({}), { personal: false, work: false });
});

test("unknown fields are dropped rather than forwarded", () => {
  const out = payloadOf({
    summary: "Standup",
    from: "2026-09-01T09:00:00-04:00",
    to: "2026-09-01T09:15:00-04:00",
    calendarId: "primary",
    "--enable-commands-exact": "calendar.delete",
    sendUpdates: "all",
  });
  assert.deepEqual(Object.keys(out).sort(), ["from", "summary", "to"]);
});

test("times must be full RFC3339 with a zone", () => {
  for (const bad of ["2026-09-01", "2026-09-01T09:00", "tomorrow", "2026-13-01T09:00:00Z"]) {
    assert.throws(() => payloadOf({ from: bad }), CalendarRefused);
  }
  assert.doesNotThrow(() => payloadOf({ from: "2026-09-01T09:00:00Z" }));
  assert.doesNotThrow(() => payloadOf({ to: "2026-09-01 09:00-04:00" }));
});

test("attendees must be addresses, and are capped", () => {
  assert.throws(() => payloadOf({ attendees: ["nope"] }), CalendarRefused);
  const many = Array.from({ length: 40 }, (_, i) => `a${i}@example.com`);
  assert.equal(payloadOf({ attendees: many }).attendees.split(",").length, 25);
});

test("long text is bounded", () => {
  const out = payloadOf({ summary: "x".repeat(5000), description: "y".repeat(9000) });
  assert.equal(out.summary.length, 300);
  assert.equal(out.description.length, 2000);
});

test("create builds a fixed argv: verb, address, one JSON argument", async () => {
  const { calls, runner } = recorder();
  await createEvent(
    {
      account: "work",
      payload: { summary: "Review", from: "2026-09-01T09:00:00Z", to: "2026-09-01T10:00:00Z" },
    },
    opts(runner),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "bash");
  assert.equal(calls[0].args.length, 4);
  assert.deepEqual(calls[0].args.slice(0, 3), [SCRIPT, "create", "work@example.net"]);
  assert.deepEqual(JSON.parse(calls[0].args[3]), {
    summary: "Review",
    from: "2026-09-01T09:00:00Z",
    to: "2026-09-01T10:00:00Z",
  });
});

test("create needs a title, a start and an end", async () => {
  const { runner } = recorder();
  await assert.rejects(
    () => createEvent({ account: "personal", payload: { summary: "Only a title" } }, opts(runner)),
    CalendarRefused,
  );
});

test("update needs a valid event id and at least one change", async () => {
  const { calls, runner } = recorder();
  await assert.rejects(
    () => updateEvent({ account: "personal", eventId: "a b;c", payload: { summary: "x" } }, opts(runner)),
    CalendarRefused,
  );
  await assert.rejects(
    () => updateEvent({ account: "personal", eventId: "abc123", payload: {} }, opts(runner)),
    CalendarRefused,
  );
  assert.equal(calls.length, 0);

  await updateEvent({ account: "personal", eventId: "abc123", payload: { summary: "x" } }, opts(runner));
  assert.deepEqual(calls[0].args.slice(0, 4), [SCRIPT, "update", "personal@example.com", "abc123"]);
});

test("the script's own refusal reaches the caller; anything else is reported by shape", async () => {
  const good = { env: ENV, script: SCRIPT, runner: failing("REFUSED: this station has no calendar delete path, by design.") };
  await assert.rejects(
    () => createEvent({ account: "work", payload: { summary: "a", from: "2026-09-01T09:00:00Z", to: "2026-09-01T10:00:00Z" } }, good),
    (err) => err instanceof CalendarRefused && /no calendar delete path/.test(err.message),
  );

  const noisy = { env: ENV, script: SCRIPT, runner: failing("gog panic: goroutine 1 [running]:\n\tstack…") };
  await assert.rejects(
    () => createEvent({ account: "work", payload: { summary: "a", from: "2026-09-01T09:00:00Z", to: "2026-09-01T10:00:00Z" } }, noisy),
    (err) => err instanceof CalendarRefused && err.message === "The station couldn't complete that change.",
  );
});

test("with no script configured nothing runs", async () => {
  await assert.rejects(
    () =>
      createEvent(
        { account: "work", payload: { summary: "a", from: "2026-09-01T09:00:00Z", to: "2026-09-01T10:00:00Z" } },
        { env: ENV, script: "" },
      ),
    CalendarRefused,
  );
});

// --- the route surface -----------------------------------------------------

function fakeRes() {
  return {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(text) {
      this.body = text || "";
    },
  };
}

function fakeReq(method, url, body) {
  const handlers = {};
  const req = {
    method,
    url,
    on(event, fn) {
      handlers[event] = fn;
      return req;
    },
    destroy() {},
  };
  queueMicrotask(() => {
    if (body !== undefined && handlers.data) handlers.data(Buffer.from(body));
    if (handlers.end) handlers.end();
  });
  return req;
}

async function hit(handler, method, url, body) {
  const res = fakeRes();
  await handler(fakeReq(method, url, body), res);
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

test("status reports which accounts are wired, without disclosing an address", async () => {
  const handler = createHandler({ env: ENV, script: SCRIPT, runner: recorder().runner });
  const out = await hit(handler, "GET", "/v1/calendar/status");
  assert.equal(out.status, 200);
  assert.deepEqual(out.json, { available: true, accounts: { personal: true, work: true } });
  assert.ok(!JSON.stringify(out.json).includes("@"));
});

test("there is no third verb — delete, move and respond are 404, not refusals to parse", async () => {
  const { calls, runner } = recorder();
  const handler = createHandler({ env: ENV, script: SCRIPT, runner });
  for (const [method, path] of [
    ["POST", "/v1/calendar/delete"],
    ["POST", "/v1/calendar/move"],
    ["POST", "/v1/calendar/respond"],
    ["POST", "/v1/mail/send"],
    ["DELETE", "/v1/calendar/create"],
    ["GET", "/v1/calendar/create"],
    ["POST", "/v1/calendar/create/../delete"],
  ]) {
    const out = await hit(handler, method, path, "{}");
    assert.equal(out.status, 404, `${method} ${path}`);
  }
  assert.equal(calls.length, 0);
});

test("an unreadable body is a 400 and runs nothing", async () => {
  const { calls, runner } = recorder();
  const handler = createHandler({ env: ENV, script: SCRIPT, runner });
  const out = await hit(handler, "POST", "/v1/calendar/create", "{not json");
  assert.equal(out.status, 400);
  assert.equal(calls.length, 0);
});

test("a refusal is a 422 carrying the sentence; a create round-trips as 200", async () => {
  const { calls, runner } = recorder('{"id":"evt_1","htmlLink":"https://example.com/e"}');
  const handler = createHandler({ env: ENV, script: SCRIPT, runner });

  const bad = await hit(handler, "POST", "/v1/calendar/create", JSON.stringify({ account: "nope", payload: {} }));
  assert.equal(bad.status, 422);
  assert.match(bad.json.error, /one of the two accounts/);
  assert.equal(calls.length, 0);

  const ok = await hit(
    handler,
    "POST",
    "/v1/calendar/create",
    JSON.stringify({
      account: "personal",
      payload: { summary: "Dentist", from: "2026-09-01T09:00:00Z", to: "2026-09-01T10:00:00Z" },
    }),
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.match(ok.json.stdout, /evt_1/);
  assert.equal(calls.length, 1);
});

test("an unexpected error never relays its text", async () => {
  const handler = createHandler({
    env: ENV,
    script: SCRIPT,
    runner: () => {
      throw new Error("/opt/orderly/config/orderly-calendar.sh --secret-argv");
    },
  });
  const out = await hit(
    handler,
    "POST",
    "/v1/calendar/create",
    JSON.stringify({
      account: "personal",
      payload: { summary: "a", from: "2026-09-01T09:00:00Z", to: "2026-09-01T10:00:00Z" },
    }),
  );
  assert.equal(out.status, 500);
  assert.equal(out.json.error, "The station couldn't complete that change.");
  assert.ok(!out.json.error.includes("orderly-calendar.sh"));
});
