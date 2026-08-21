// ORDERLY — the front door's calendar-write CLIENT.
//
// This is the ONLY file in the web surface that can change anything outside
// this station, and it can change exactly two things: it can create a calendar
// event, and it can update one. It cannot delete one, cannot move one, cannot
// touch a mailbox, and holds no credential of its own.
//
// How it works, and why it is shaped like this:
//
//   * The credential lives in a gog store on the host that NO AGENT CONTAINER
//     MOUNTS, and that THIS PROCESS CANNOT SEE EITHER. Writing needs Docker,
//     because `gog` exists only inside the sandbox image — and per
//     INSTALL-PLAN.md Phase 1 the front door is deliberately not in `docker`
//     and never will be, that group being host-root-equivalent.
//   * So the write moved behind a separately reviewed typed helper
//     (`calendar/server.mjs`, `orderly-calendar.service`), which runs as the
//     host identity that already owns the store and already has Docker. This
//     process reaches it over a mode-0660 UNIX socket it can open only because
//     it is a member of the helper's socket group — the same shape as the
//     orchestration broker, and the same reason: the front door forwards a
//     typed verb, it does not hold the authority.
//   * Nothing here becomes a path, a flag, an argv element or an environment
//     entry on the other side. This process sends one of two verbs, an account
//     WORD, and bounded scalar fields as JSON. It does not even know the two
//     mailbox addresses — the helper owns that mapping, so a compromise of the
//     front door does not leak them.
//   * A write happens ONLY on an approve decision the operator made on the
//     front door. There is no endpoint that writes a calendar directly, and
//     there is no path from an agent to this code: agents are in containers,
//     this is on the host, and `tools.elevated.enabled` is false.
//
// The verb "approve" therefore means two different things on this station, and
// the UI has to say which: on a DRAFT it means read-and-kept and nothing
// happens; on an EVENT PROPOSAL it means do it, now, for real.

import { request as httpRequest } from "node:http";
import { join } from "node:path";

const SOCKET =
  process.env.ORDERLY_CALENDAR_SOCKET ||
  join(process.env.HOME || "", ".orderly-calendar", "calendar.sock");

// The helper caps its own work at 60s. This waits a little longer so a helper
// that refuses on time gets to say why, rather than being cut off and reported
// as unreachable.
const TIMEOUT_MS = 75_000;
const STATUS_TIMEOUT_MS = 2_000;
const STATUS_TTL_MS = 30_000;

export class CalendarRefused extends Error {}

const ACCOUNTS = new Set(["personal", "work"]);
const TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/;
const EVENT_ID = /^[A-Za-z0-9_@.-]{1,256}$/;

// The shape and the instant are different questions: the regex alone accepts
// month 13. Checked here so the operator gets a sentence, and again on the
// helper so the socket is safe without this file.
function isRealTime(value) {
  return TIME.test(value) && Number.isFinite(Date.parse(value.replace(" ", "T")));
}

function call(path, method, body, { socketPath = SOCKET, requestImpl = httpRequest, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    let req;
    try {
      req = requestImpl({
        socketPath,
        path,
        method,
        headers: {
          Accept: "application/json",
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
        },
      });
    } catch {
      reject(new CalendarRefused("The calendar helper isn't reachable from this station."));
      return;
    }
    req.setTimeout(timeoutMs, () => req.destroy(new Error("calendar-timeout")));
    req.once("error", () =>
      reject(new CalendarRefused("The calendar helper isn't reachable from this station.")),
    );
    req.once("response", (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let obj = null;
        try {
          obj = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          obj = null;
        }
        if ((res.statusCode || 500) >= 400) {
          // The helper's refusals are written for a person and are safe to
          // relay. Anything else is reported by shape; the browser never
          // receives a stack, an argv or an address.
          reject(new CalendarRefused(obj?.error || "The station couldn't complete that change."));
          return;
        }
        resolvePromise(obj || {});
      });
      res.on("error", () => reject(new CalendarRefused("The station couldn't complete that change.")));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// Asked of the helper rather than assumed, and cached briefly because the queue
// endpoint is polled. A station whose calendar accounts are not wired — or
// whose helper is not running — shows the proposal and says plainly that
// approving it would fail, instead of offering a button that throws.
let statusCache = { at: 0, value: false };

export async function calendarConfigured(options = {}) {
  const now = Date.now();
  if (!options.fresh && now - statusCache.at < STATUS_TTL_MS) return statusCache.value;
  let value = false;
  try {
    const res = await call("/v1/calendar/status", "GET", undefined, {
      timeoutMs: STATUS_TIMEOUT_MS,
      ...options,
    });
    value = Boolean(res?.available);
  } catch {
    value = false;
  }
  statusCache = { at: now, value };
  return value;
}

// Test seam: the cache is deliberately process-lifetime, so a suite that
// exercises two different helpers has to be able to clear it.
export function resetCalendarStatusCache() {
  statusCache = { at: 0, value: false };
}

// gog --json prints the event object. What matters afterwards is the id (so an
// update can find it again) and the link (so the operator can go and look).
// A write that succeeded but whose output could not be parsed is still a
// success — saying otherwise would invite a second write.
function readResult(stdout) {
  let obj = null;
  try {
    obj = JSON.parse(stdout);
  } catch {
    const brace = stdout.indexOf("{");
    if (brace !== -1) {
      try {
        obj = JSON.parse(stdout.slice(brace));
      } catch {
        obj = null;
      }
    }
  }
  const event = obj?.event ?? obj?.result ?? obj;
  const id = typeof event?.id === "string" ? event.id : null;
  const link = typeof event?.htmlLink === "string" ? event.htmlLink : null;
  return { eventId: id, link, parsed: Boolean(id) };
}

// The proposal as it sits on the queue, turned into the change to make. Every
// field is re-checked here even though the helper and the script check them
// again: this side can give the operator a sentence, the others can only
// refuse. Each layer is written to be sufficient on its own.
function payloadOf(item) {
  const out = {};
  if (item.summary) out.summary = String(item.summary).slice(0, 300);
  if (item.from) out.from = String(item.from);
  if (item.to) out.to = String(item.to);
  if (item.location) out.location = String(item.location).slice(0, 300);
  if (item.description) out.description = String(item.description).slice(0, 2000);
  if (Array.isArray(item.attendees) && item.attendees.length) {
    out.attendees = item.attendees.slice(0, 25).join(",");
  }
  for (const key of ["from", "to"]) {
    if (out[key] && !isRealTime(out[key])) {
      throw new CalendarRefused(
        `The ${key === "from" ? "start" : "end"} time on this proposal isn't a full date and time with a timezone, so it won't be sent as one.`,
      );
    }
  }
  return out;
}

function accountOf(item) {
  if (!ACCOUNTS.has(item?.account)) throw new CalendarRefused("That isn't one of the two accounts.");
  return item.account;
}

export async function applyProposal(item, options = {}) {
  const account = accountOf(item);
  const payload = payloadOf(item);

  if (item.action === "create") {
    if (!payload.summary || !payload.from || !payload.to) {
      throw new CalendarRefused("A new event needs a title, a start and an end. This proposal is missing one.");
    }
    const res = await call("/v1/calendar/create", "POST", { account, payload }, options);
    return {
      ...readResult(String(res?.stdout || "")),
      action: "create",
      account,
      at: new Date().toISOString(),
    };
  }

  if (item.action === "update") {
    if (!item.eventId || !EVENT_ID.test(String(item.eventId))) {
      throw new CalendarRefused("This proposal says it changes an existing event but doesn't name a valid one.");
    }
    if (!Object.keys(payload).length) {
      throw new CalendarRefused("This proposal changes nothing.");
    }
    const res = await call(
      "/v1/calendar/update",
      "POST",
      { account, eventId: String(item.eventId), payload },
      options,
    );
    const parsed = readResult(String(res?.stdout || ""));
    return {
      ...parsed,
      eventId: parsed.eventId || String(item.eventId),
      action: "update",
      account,
      at: new Date().toISOString(),
    };
  }

  // Not reachable through the queue — proposals are validated on the way in —
  // but stated here too, because this is the file where it would matter.
  throw new CalendarRefused("This station creates and updates events. It has no other calendar verb.");
}
