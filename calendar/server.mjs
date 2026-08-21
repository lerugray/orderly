#!/usr/bin/env node
// ORDERLY calendar helper — the two calendar writes, behind one typed socket.
//
// WHY THIS FILE EXISTS
// --------------------
// `INSTALL-PLAN.md` Phase 1 requires the front door to be Docker-free, and it
// names the consequence honestly: the calendar write needs Docker, because
// `gog` exists only inside the sandbox image, so splitting the identities
// breaks calendar create/update until "its Docker dependency has moved". This
// file is that move — the "separately reviewed typed helper" the same
// paragraph calls for.
//
// The authority is not re-granted, it is left where it already legitimately
// lives. The host identity that owns `~/.openclaw/calendar-write` and is
// already in `docker` keeps both; the front door is handed a UNIX socket with
// exactly two verbs on it and gains neither. Nothing was added to the `docker`
// group to make this work, and nothing needs to be.
//
// THE BOUNDARY, PRECISELY
// -----------------------
// Nothing arriving on the wire becomes a path, a flag, an argv element, an
// environment entry, a file name or a model. A request chooses:
//
//   * one of exactly two verbs (`create`, `update`) — chosen by ROUTE, so an
//     unknown verb is a 404 rather than a value this file has to reason about;
//   * one of exactly two ACCOUNT WORDS (`personal`, `work`) — the word→address
//     mapping is host-owned, supplied by the systemd unit, and a word with no
//     address behind it is a refusal rather than a guess;
//   * bounded scalar fields, each re-validated by shape here.
//
// The script path is host-owned. The store, the keyring and the container
// invocation are the script's, unchanged. There is deliberately no delete verb,
// no route that takes an email address, and no route that takes a command.
//
// Validation happens three times on purpose — once in the front door (so the
// operator gets a sentence), once here (so this socket is safe on its own
// terms, whatever is on the other end of it), and once in the script (so the
// argv is safe whatever calls it). Each layer is written to be sufficient
// alone.

import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const DEFAULT_SOCKET = join(homedir(), ".orderly-calendar", "calendar.sock");
const SOCKET_PATH = process.env.ORDERLY_CALENDAR_SOCKET || DEFAULT_SOCKET;
const SCRIPT = process.env.ORDERLY_CALENDAR_SCRIPT || "";

// A container start plus a Google round trip. Generous, but bounded: a hung
// write must not hold the front door's request — and therefore the operator's
// browser — open forever.
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 256 * 1024;
const MAX_BODY = 64 * 1024;

const ACCOUNTS = ["personal", "work"];
const TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/;
const EVENT_ID = /^[A-Za-z0-9_@.-]{1,256}$/;
const EMAIL = /^[^\s,@]+@[^\s,@]+\.[^\s,@]+$/;
// The regex is a shape, not a date: it will happily accept month 13. The
// script's validator has the same shape and the same blind spot, so the check
// that a time is a real instant is made here, once, rather than left to Google
// to discover after the request has left the host.
const CONTROL = /[\u0000-\u001f]/;

function isRealTime(value) {
  return TIME.test(value) && Number.isFinite(Date.parse(value.replace(" ", "T")));
}

export class CalendarRefused extends Error {}

// The two mailbox WORDS are not addresses. The mapping lives in the unit's
// environment, on this side of the socket, so the front door never holds an
// address at all — it names an account and this file decides whether it knows
// one. A word with no address behind it is a refusal, never a guess.
export function addressFor(account, env = process.env) {
  if (!ACCOUNTS.includes(account)) throw new CalendarRefused("That isn't one of the two accounts.");
  const value = account === "work" ? env.ORDERLY_WORK_EMAIL : env.ORDERLY_GMAIL;
  if (!value || !EMAIL.test(value)) {
    throw new CalendarRefused(
      `This station doesn't know the address of your ${account} account, so it won't guess one. Set ORDERLY_${account === "work" ? "WORK_EMAIL" : "GMAIL"} on orderly-calendar.service.`,
    );
  }
  return value;
}

export function configuredAccounts(env = process.env) {
  const out = {};
  for (const account of ACCOUNTS) {
    try {
      addressFor(account, env);
      out[account] = true;
    } catch {
      out[account] = false;
    }
  }
  return out;
}

// Re-validated here even though the front door validated it: this socket has to
// be safe on its own terms. Every field is bounded, and an unknown field is
// dropped rather than passed on — the script takes a fixed set and a surprise
// key is a caller bug, not something to forward.
export function payloadOf(raw) {
  if (!raw || typeof raw !== "object") throw new CalendarRefused("This proposal has no fields.");
  const out = {};
  for (const [key, limit] of [
    ["summary", 300],
    ["location", 300],
    ["description", 2000],
  ]) {
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== "") {
      if (typeof raw[key] !== "string") throw new CalendarRefused(`The ${key} on this proposal isn't text.`);
      if (CONTROL.test(raw[key])) throw new CalendarRefused(`The ${key} on this proposal has control characters in it.`);
      out[key] = raw[key].slice(0, limit);
    }
  }
  for (const key of ["from", "to"]) {
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== "") {
      if (typeof raw[key] !== "string" || !isRealTime(raw[key])) {
        throw new CalendarRefused(
          `The ${key === "from" ? "start" : "end"} time on this proposal isn't a full date and time with a timezone, so it won't be sent as one.`,
        );
      }
      out[key] = raw[key];
    }
  }
  if (raw.attendees !== undefined && raw.attendees !== null && raw.attendees !== "") {
    const list = Array.isArray(raw.attendees) ? raw.attendees : String(raw.attendees).split(",");
    const cleaned = list.map((a) => String(a).trim()).filter(Boolean).slice(0, 25);
    for (const address of cleaned) {
      if (!EMAIL.test(address)) throw new CalendarRefused("One of the attendees on this proposal isn't an address.");
    }
    if (cleaned.length) out.attendees = cleaned.join(",");
  }
  return out;
}

function runScript(args, { runner = execFile, script = SCRIPT } = {}) {
  return new Promise((resolvePromise, reject) => {
    if (!script) {
      reject(new CalendarRefused("This station has no calendar script configured."));
      return;
    }
    runner(
      "bash",
      [script, ...args],
      { timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT },
      (err, stdout, stderr) => {
        if (err) {
          // The script's own refusals are written for a person and are safe to
          // relay onwards; anything else is reported by shape. Neither a stack
          // nor an argv nor an address ever leaves this process.
          const lines = String(stderr || "")
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
          const own = lines.find((l) => l.startsWith("FATAL:") || l.startsWith("REFUSED:"));
          const first = lines[0];
          const said = own
            ? own.replace(/^(FATAL|REFUSED):\s*/, "")
            : first && first.length <= 160 && !first.includes("gog ")
              ? first
              : null;
          reject(new CalendarRefused(said || "The station couldn't complete that change."));
          return;
        }
        resolvePromise(String(stdout));
      },
    );
  });
}

export async function createEvent(body, options = {}) {
  const account = addressFor(body?.account, options.env);
  const payload = payloadOf(body?.payload);
  if (!payload.summary || !payload.from || !payload.to) {
    throw new CalendarRefused("A new event needs a title, a start and an end. This proposal is missing one.");
  }
  return runScript(["create", account, JSON.stringify(payload)], options);
}

export async function updateEvent(body, options = {}) {
  const account = addressFor(body?.account, options.env);
  const eventId = body?.eventId;
  if (typeof eventId !== "string" || !EVENT_ID.test(eventId)) {
    throw new CalendarRefused("This proposal says it changes an existing event but doesn't name a valid one.");
  }
  const payload = payloadOf(body?.payload);
  if (!Object.keys(payload).length) throw new CalendarRefused("This proposal changes nothing.");
  return runScript(["update", account, eventId, JSON.stringify(payload)], options);
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body-too-large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function reply(res, status, obj) {
  const text = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

export function createHandler(options = {}) {
  return async function handle(req, res) {
    const path = (req.url || "").split("?")[0];

    if (req.method === "GET" && path === "/v1/calendar/status") {
      const accounts = configuredAccounts(options.env);
      return reply(res, 200, {
        available: Object.values(accounts).some(Boolean),
        accounts,
      });
    }

    // The verb is the ROUTE. An unknown verb never becomes a value this file
    // has to reason about, and there is deliberately no route for delete,
    // move, respond, or anything at all touching a mailbox.
    const verb =
      req.method === "POST" && path === "/v1/calendar/create"
        ? createEvent
        : req.method === "POST" && path === "/v1/calendar/update"
          ? updateEvent
          : null;
    if (!verb) return reply(res, 404, { error: "This station creates and updates events. It has no other calendar verb." });

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return reply(res, 400, { error: "Unreadable request." });
    }

    try {
      const stdout = await verb(body, options);
      return reply(res, 200, { ok: true, stdout });
    } catch (err) {
      if (err instanceof CalendarRefused) return reply(res, 422, { error: err.message });
      // Never relay an unexpected error's text: it can carry an argv or a path.
      console.error("[orderly-calendar] write failed:", err?.code || "unknown");
      return reply(res, 500, { error: "The station couldn't complete that change." });
    }
  };
}

export class CalendarHelper {
  constructor({ socketPath = SOCKET_PATH, ...options } = {}) {
    this.socketPath = socketPath;
    this.server = createServer(createHandler(options));
  }

  async listen() {
    // 0710 on the directory, exactly as the broker's is: the front door's
    // socket-group membership permits traversal to the known socket, not
    // listing or replacing anything beside it.
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o710 });
    await chmod(dirname(this.socketPath), 0o710);
    try {
      const info = await lstat(this.socketPath);
      if (!info.isSocket()) throw new Error(`refusing to replace non-socket ${this.socketPath}`);
      await rm(this.socketPath);
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
    await new Promise((resolvePromise, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        this.server.removeListener("error", reject);
        resolvePromise();
      });
    });
    await chmod(this.socketPath, 0o660);
  }

  async close() {
    if (this.server.listening) await new Promise((done) => this.server.close(done));
    await rm(this.socketPath, { force: true }).catch(() => {});
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  const helper = new CalendarHelper();
  await helper.listen();
  process.stdout.write(`ORDERLY calendar helper listening on ${helper.socketPath}\n`);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      helper.close().finally(() => process.exit(0));
    });
  }
}
