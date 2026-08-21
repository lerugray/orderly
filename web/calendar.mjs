// ORDERLY — the front door's calendar-write executor.
//
// This is the ONLY file in the web surface that can change anything outside
// this station, and it can change exactly two things: it can create a calendar
// event, and it can update one. It cannot delete one, cannot move one, cannot
// touch a mailbox, and holds no credential of its own.
//
// How it works, and why it is shaped like this:
//
//   * The credential lives in a gog store on the host that NO AGENT CONTAINER
//     MOUNTS. This process does not read it either. It runs a host script
//     (config/orderly-calendar.sh) which starts a short-lived container with
//     that store bound in, and the container dies with the command.
//   * The invocation is execFile, never a shell. Every operator- and
//     model-supplied value crosses as a separate argv entry inside one JSON
//     argument, and the script validates each field by shape before it becomes
//     a flag. Nothing here is interpolated into a command line.
//   * A write happens ONLY on an approve decision the operator made on the
//     front door. There is no endpoint that writes a calendar directly, and
//     there is no path from an agent to this code: agents are in containers,
//     this is on the host, and `tools.elevated.enabled` is false.
//
// The verb "approve" therefore means two different things on this station, and
// the UI has to say which: on a DRAFT it means read-and-kept and nothing
// happens; on an EVENT PROPOSAL it means do it, now, for real.

import { execFile } from "node:child_process";
import { join } from "node:path";

const SCRIPT =
  process.env.ORDERLY_CALENDAR_SCRIPT ||
  join(process.env.HOME || "", ".orderly-web", "orderly-calendar.sh");

// A container start plus a Google round trip. Generous, but bounded: a hung
// write must not hold a browser request open forever.
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 256 * 1024;

export class CalendarRefused extends Error {}

const ACCOUNTS = new Set(["personal", "work"]);
const TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/;
const EVENT_ID = /^[A-Za-z0-9_@.-]{1,256}$/;

// The two mailbox WORDS the operator and the agents use are not addresses, and
// `-a` takes an address — the exact mistake POLICY-GUARD records for the mail
// desk. The mapping lives here, in the environment, and a word with no address
// behind it is a refusal rather than a guess.
function addressFor(account) {
  if (!ACCOUNTS.has(account)) throw new CalendarRefused("That isn't one of the two accounts.");
  const value =
    account === "work" ? process.env.ORDERLY_WORK_EMAIL : process.env.ORDERLY_GMAIL;
  if (!value) {
    throw new CalendarRefused(
      `This front door doesn't know the address of your ${account} account, so it won't guess one. Set ORDERLY_${account === "work" ? "WORK_EMAIL" : "GMAIL"} on orderly-web.service.`,
    );
  }
  return value;
}

export function calendarConfigured() {
  return Boolean(process.env.ORDERLY_GMAIL || process.env.ORDERLY_WORK_EMAIL);
}

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(
      "bash",
      [SCRIPT, ...args],
      { timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT },
      (err, stdout, stderr) => {
        if (err) {
          // The script's own refusals are written for a person and are safe to
          // relay; anything else is reported by shape. Either way the browser
          // never receives a stack or an argv.
          const lines = String(stderr || "")
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
          // The script's own refusals are written for a person. Failing that,
          // gog's first line is usually the actual reason ("No auth for
          // calendar ...", a 403, a bad time) and is far more use to the
          // operator than a shrug — but only the FIRST line, and only if it
          // reads like a sentence rather than a dump.
          const own = lines.find((l) => l.startsWith("FATAL:") || l.startsWith("REFUSED:"));
          const first = lines[0];
          const said = own
            ? own.replace(/^(FATAL|REFUSED):\s*/, "")
            : first && first.length <= 160 && !first.includes("gog ")
              ? first
              : null;
          reject(
            new CalendarRefused(
              said ? `The station said: ${said}` : "The station couldn't complete that change.",
            ),
          );
          return;
        }
        resolve(String(stdout));
      },
    );
  });
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
// field is re-checked here even though the script checks them again: this side
// can give the operator a sentence, the script can only refuse.
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
    if (out[key] && !TIME.test(out[key])) {
      throw new CalendarRefused(
        `The ${key === "from" ? "start" : "end"} time on this proposal isn't a full date and time with a timezone, so it won't be sent as one.`,
      );
    }
  }
  return out;
}

export async function applyProposal(item) {
  const account = addressFor(item.account);
  const payload = payloadOf(item);

  if (item.action === "create") {
    if (!payload.summary || !payload.from || !payload.to) {
      throw new CalendarRefused("A new event needs a title, a start and an end. This proposal is missing one.");
    }
    const out = await run(["create", account, JSON.stringify(payload)]);
    return { ...readResult(out), action: "create", account: item.account, at: new Date().toISOString() };
  }

  if (item.action === "update") {
    if (!item.eventId || !EVENT_ID.test(String(item.eventId))) {
      throw new CalendarRefused("This proposal says it changes an existing event but doesn't name a valid one.");
    }
    if (!Object.keys(payload).length) {
      throw new CalendarRefused("This proposal changes nothing.");
    }
    const out = await run(["update", account, String(item.eventId), JSON.stringify(payload)]);
    return {
      ...readResult(out),
      eventId: readResult(out).eventId || String(item.eventId),
      action: "update",
      account: item.account,
      at: new Date().toISOString(),
    };
  }

  // Not reachable through the queue — proposals are validated on the way in —
  // but stated here too, because this is the file where it would matter.
  throw new CalendarRefused("This station creates and updates events. It has no other calendar verb.");
}
