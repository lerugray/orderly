// ORDERLY — the approval queue.
//
// The queue holds two kinds of card, and they are opposites. Getting that
// difference in front of the operator is most of what this file and its UI are
// for, because the same button means two different things:
//
//   DRAFT      — an email the agent wrote. Approving RECORDS that the operator
//                read it and kept it. Nothing is sent, nothing can be sent,
//                and no code here touches a mailbox. The wall is exactly where
//                it was.
//   PROPOSAL   — a calendar event an agent has ASKED FOR. Approving MAKES THE
//                CHANGE: a real event appears in, or changes in, a real
//                calendar, at the moment of the click. Discarding does nothing
//                at all.
//
// Which is why an event card asks the operator to confirm on APPROVE, where a
// draft card asks on discard. The dangerous direction is not the same one.
//
// The write itself is not in this file. It is injected as `execute` by the
// server, which holds it in web/calendar.mjs — one module, two verbs, no
// credential, and a host script behind it that runs a throwaway container
// against a credential store no agent container mounts. This file decides; it
// does not act.
//
// Sources, all deliberately different shapes:
//
//   1. PENDING.md in the coordinator's workspace — the append-only log it
//      writes when it makes a draft or asks for an event. The front door never
//      writes to it: that directory belongs to the host, and a log written by
//      one side and read by the other needs no lock.
//   2. Cards this server SAW go past in a chat reply. Deterministic — the card
//      came out of the reply's own fenced block and nothing was asked to
//      remember it — and the only path that carries a draft's text.
//
// The decisions live HERE, in this server's own store, and never travel back to
// the agent. Nothing the operator decides becomes an instruction to a model,
// and an approval cannot be forged by anything a model writes into a file.

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// A draft line the coordinator wrote:
//   - q-20260820-0735-1 | t-testnyt | personal | someone@example.com | Re: subject
// Column zero, like the reminder store, so the format example indented inside
// the file's own explanation is not read back as a real item.
const PENDING_LINE =
  /^-\s+(q-[A-Za-z0-9-]{1,48})\s*\|\s*([^|]{1,60}?)\s*\|\s*([^|]{1,20}?)\s*\|\s*([^|]{1,200}?)\s*\|\s*(.{1,200}?)\s*$/;

// An event proposal, ten columns and always ten, so create and update never
// mean different things by position:
//   - e-20260820-0900-1 | create | chat | personal | Dentist | 2026-08-25T14:00:00-04:00 | 2026-08-25T15:00:00-04:00 | - | - | you asked me to book it
//   - e-20260820-0910-1 | update | t-invoices | work | Review | 2026-08-26T09:00:00-04:00 | 2026-08-26T10:00:00-04:00 | abc123 | a@b.co | moved at their request
const EVENT_LINE = new RegExp(
  "^-\\s+(e-[A-Za-z0-9-]{1,48})\\s*\\|" +
    "\\s*(create|update)\\s*\\|" +
    "\\s*([^|]{1,60}?)\\s*\\|" +
    "\\s*([^|]{1,20}?)\\s*\\|" +
    "\\s*([^|]{1,200}?)\\s*\\|" +
    "\\s*([^|]{1,60}?)\\s*\\|" +
    "\\s*([^|]{1,60}?)\\s*\\|" +
    "\\s*([^|]{0,256}?)\\s*\\|" +
    "\\s*([^|]{0,300}?)\\s*\\|" +
    "\\s*(.{0,300}?)\\s*$",
);

const PENDING_MAX = 60;
const OBSERVED_MAX = 200;
const DECISIONS_MAX = 800;
const RESULTS_MAX = 200;
const BODY_MAX = 4000;
const DEDUPE_WINDOW_MS = 30 * 60 * 1000;

// A time this station will act on has to be a full instant with an offset. A
// bare timestamp is read as UTC by everything downstream, which is how an
// event lands four hours from where the operator meant it.
const TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/;
const EVENT_ID = /^[A-Za-z0-9_@.-]{1,256}$/;

export class QueueRefused extends Error {}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

const EMPTY = { v: 2, observed: [], decisions: {}, results: {} };

async function loadState(statePath) {
  let raw;
  try {
    raw = await readFile(statePath, "utf8");
  } catch {
    return { ...EMPTY, observed: [], decisions: {}, results: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt store is not a reason to lose the queue: the file sources still
    // work, and the next write lays down a clean one. Losing decisions is the
    // mild failure here — a decided card simply reappears.
    return { ...EMPTY, observed: [], decisions: {}, results: {} };
  }
  const observed = Array.isArray(parsed?.observed) ? parsed.observed.filter(isItem) : [];
  const decisions = {};
  if (parsed?.decisions && typeof parsed.decisions === "object") {
    for (const [id, value] of Object.entries(parsed.decisions)) {
      const decision = value?.decision;
      if (decision !== "approved" && decision !== "discarded") continue;
      decisions[String(id).slice(0, 64)] = {
        decision,
        at: typeof value?.at === "string" ? value.at : new Date().toISOString(),
      };
    }
  }
  const results = {};
  if (parsed?.results && typeof parsed.results === "object") {
    for (const [id, value] of Object.entries(parsed.results)) {
      if (!value || typeof value !== "object") continue;
      results[String(id).slice(0, 64)] = {
        eventId: typeof value.eventId === "string" ? value.eventId.slice(0, 256) : null,
        link: typeof value.link === "string" ? value.link.slice(0, 500) : null,
        action: value.action === "update" ? "update" : "create",
        account: value.account === "work" ? "work" : "personal",
        at: typeof value.at === "string" ? value.at : null,
      };
    }
  }
  return { v: 2, observed, decisions, results };
}

function isItem(item) {
  return item && typeof item.id === "string" && typeof item.at === "string";
}

// Whole file or none: the store is small, and a half-written queue that loses a
// decision is worse than one that loses the last write.
async function saveState(statePath, state) {
  const body = JSON.stringify(state);
  const tmp = `${statePath}.tmp-${process.pid}`;
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(tmp, body, { mode: 0o600 });
  await rename(tmp, statePath);
}

// This server is single-threaded but its handlers are not: two decisions landing
// together would otherwise read the same state and one would be lost. With a
// real calendar write now sitting inside the critical section, this also means
// two tabs cannot fire the same proposal twice.
let chain = Promise.resolve();
function serialise(work) {
  const next = chain.then(work, work);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

function clean(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, max)
    .trim();
}

function accountOf(raw) {
  const word = clean(raw, 20).toLowerCase();
  return word === "work" ? "work" : word === "personal" ? "personal" : null;
}

function dashless(value, max) {
  const out = clean(value, max);
  return out === "-" || out === "" ? null : out;
}

// A proposal that cannot be acted on should not reach the operator wearing a
// button that would fail. Shape is checked on the way IN, so what is on the
// queue is what the station can actually do.
function readableProposal(item) {
  if (item.action !== "create" && item.action !== "update") return false;
  if (!item.account) return false;
  if (!TIME.test(String(item.from ?? ""))) return false;
  if (!TIME.test(String(item.to ?? ""))) return false;
  if (Date.parse(item.to) <= Date.parse(item.from)) return false;
  if (item.action === "create" && !item.summary) return false;
  if (item.action === "update" && !EVENT_ID.test(String(item.eventId ?? ""))) return false;
  return true;
}

async function readPendingFile(pendingPath) {
  let text;
  try {
    text = await readFile(pendingPath, "utf8");
  } catch {
    return { present: false, items: [] };
  }
  const drafts = [];
  const events = [];
  for (const line of text.split("\n")) {
    const d = PENDING_LINE.exec(line);
    if (d) {
      drafts.push({
        id: d[1],
        type: "draft",
        origin: "agent",
        source: clean(d[2], 60),
        account: accountOf(d[3]),
        to: clean(d[4], 200),
        subject: clean(d[5], 200),
        body: null,
        // The log line carries no timestamp of its own; the id does, and reading
        // it out beats inventing one. An unparseable id simply sorts last.
        at: stampFromId(d[1]),
      });
      continue;
    }
    const e = EVENT_LINE.exec(line);
    if (!e) continue;
    const item = {
      id: e[1],
      type: "event",
      origin: "agent",
      action: e[2],
      source: clean(e[3], 60),
      account: accountOf(e[4]),
      summary: clean(e[5], 200),
      from: clean(e[6], 60),
      to: clean(e[7], 60),
      eventId: dashless(e[8], 256),
      attendees: splitAttendees(e[9]),
      why: dashless(e[10], 300),
      at: stampFromId(e[1]),
    };
    if (readableProposal(item)) events.push(item);
  }
  // Bound the page in readQueue, after decisions are known. Truncating here
  // drops items that have no answer yet and makes counts.pending describe the
  // page rather than the work.
  return {
    present: true,
    items: [...drafts, ...events],
  };
}

function splitAttendees(raw) {
  const value = dashless(raw, 300);
  if (!value) return [];
  return value
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter((part) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(part))
    .slice(0, 25);
}

function stampFromId(id) {
  const m = /^[qe]-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(id);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00`;
}

// The same item can arrive down both paths: the coordinator logs it AND this
// server watched the reply that announced it. They are one item, so they are
// one card — and the observed one wins, because it is the one with the detail.
function sameItem(a, b) {
  if ((a.type ?? "draft") !== (b.type ?? "draft")) return false;
  if (a.account && b.account && a.account !== b.account) return false;
  if ((a.type ?? "draft") === "event") {
    // Two proposals are the same proposal only when approving either would send
    // the same thing, compared exactly as web/calendar.mjs would send it.
    //
    // PENDING.md has ten columns and cannot express location or description, so
    // a line from the log always reports them absent. Absent-because-the-format
    // cannot-say-it is not the same as different: comparing those fields across
    // sources would split one real proposal into two cards. They are compared
    // only when both sides came from a source that can carry them.
    const loggedSide = a.origin === "agent" || b.origin === "agent";
    return effectOf(a, loggedSide) === effectOf(b, loggedSide);
  }
  if (norm(a.subject) !== norm(b.subject)) return false;
  if (norm(a.to) !== norm(b.to)) return false;
  const ta = Date.parse(a.at ?? "");
  const tb = Date.parse(b.at ?? "");
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return true;
  return Math.abs(ta - tb) < DEDUPE_WINDOW_MS;
}

// Mirrors the effect-significant inputs applyProposal() consumes in
// web/calendar.mjs: the account and action it branches on, the fields payloadOf()
// puts on the wire with its length limits, and the target event id, which is
// read on the update path only. A create is sent as { account, payload } and
// never carries an event id, so including one there would split two requests
// that produce the same booking. A field added to payloadOf() must be added
// here, or two different changes will look like one.
//
// `narrow` drops the two fields PENDING.md has no column for, so a logged line
// and a chat card describing the same booking still compare equal.
function effectOf(item, narrow) {
  const text = (value, max) => (value ? String(value).slice(0, max) : null);
  return JSON.stringify({
    action: item.action ?? null,
    account: item.account ?? null,
    // The update path is the only one that sends this, so it decides identity
    // only there.
    eventId: item.action === "update" ? (item.eventId ?? null) : null,
    summary: text(item.summary, 300),
    from: item.from ?? null,
    to: item.to ?? null,
    location: narrow ? null : text(item.location, 300),
    description: narrow ? null : text(item.description, 2000),
    attendees: Array.isArray(item.attendees) && item.attendees.length
      ? item.attendees.slice(0, 25).join(",")
      : null,
  });
}

function norm(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/^re:\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Ordering has to be total. Two cards written in the same millisecond carry the
// same timestamp, so ordering on time alone leaves their relative position free
// to change between one response and the next, which at a page edge offers one
// card twice and never offers the other.
const orderAt = (item) => Date.parse(item.at ?? "") || 0;
function byNewestThenId(a, b) {
  return (orderAt(b) - orderAt(a)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const cursorOf = (item) => `${item.at ?? ""}|${item.id}`;

// Everything ordered strictly after the cursor. This compares sort position
// rather than looking the card up, because the card the cursor names may have
// been answered since it was issued; paging must not repeat or skip its
// neighbours when the set shifts underneath the reader.
function afterCursor(list, cursor) {
  const raw = typeof cursor === "string" ? cursor : "";
  const split = raw.indexOf("|");
  if (split === -1) return list;
  const mark = { at: raw.slice(0, split), id: raw.slice(split + 1) };
  return list.filter((item) => byNewestThenId(mark, item) < 0);
}

export async function readQueue({ pendingPath, statePath, page = true, after = null }) {
  const [state, file] = await Promise.all([loadState(statePath), readPendingFile(pendingPath)]);

  const merged = state.observed.slice();
  for (const item of file.items) {
    if (merged.some((seen) => sameItem(seen, item))) continue;
    merged.push(item);
  }

  const pending = [];
  let approved = 0;
  let discarded = 0;
  let events = 0;
  const recent = [];
  for (const item of merged) {
    const decision = state.decisions[item.id];
    if (!decision) {
      pending.push(item);
      if ((item.type ?? "draft") === "event") events += 1;
      continue;
    }
    if (decision.decision === "approved") approved += 1;
    else discarded += 1;
    recent.push({
      ...item,
      decision: decision.decision,
      decidedAt: decision.at,
      result: state.results[item.id] ?? null,
    });
  }

  pending.sort(byNewestThenId);
  recent.sort((a, b) => (Date.parse(b.decidedAt ?? "") || 0) - (Date.parse(a.decidedAt ?? "") || 0));

  const remaining = page ? afterCursor(pending, after) : pending;
  const shown = page ? remaining.slice(0, PENDING_MAX * 2) : remaining;
  const more = shown.length < remaining.length;

  return {
    state: "ok",
    storeReadable: true,
    sources: { pendingFile: file.present },
    // `page` bounds one response. `after` walks past that bound, so the bound
    // keeps a single response small without putting any counted card out of
    // reach. Callers acting on a card pass page:false and see the whole set.
    pending: shown,
    nextCursor: more ? cursorOf(shown[shown.length - 1]) : null,
    counts: { pending: pending.length, events, approved, discarded },
    recent: recent.slice(0, 8).map((item) => ({
      id: item.id,
      type: item.type ?? "draft",
      subject: item.type === "event" ? item.summary : item.subject,
      decision: item.decision,
      at: item.at,
      decidedAt: item.decidedAt,
      result: item.result,
    })),
    readAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

const DECISIONS = new Set(["approve", "discard"]);
const ID_SHAPE = /^[qwev]-[A-Za-z0-9-]{1,48}$/;

// `execute` is the calendar writer, injected by the server. Passing it in
// rather than importing it keeps the shape of the trust honest: this module
// records decisions and is handed, from outside, the one capability that can
// act on one of them. A queue with no executor is a queue that can only
// record — which is exactly what it was before this milestone, and still is
// for every draft.
export function decide({ pendingPath, statePath, id, decision, execute }) {
  if (typeof id !== "string" || !ID_SHAPE.test(id)) {
    throw new QueueRefused("That isn't a card on this queue.");
  }
  if (!DECISIONS.has(decision)) {
    throw new QueueRefused("A card is approved or discarded; there is no third answer.");
  }
  return serialise(async () => {
    const current = await readQueue({ pendingPath, statePath, page: false });
    const item = current.pending.find((candidate) => candidate.id === id);
    if (!item) {
      // Either it was decided in another tab, or it never existed. Both are the
      // same answer to the browser, and neither writes anything.
      throw new QueueRefused("That card isn't waiting any more — reload to see the queue as it stands.");
    }

    // The whole difference between the two card kinds lives in these eight
    // lines. A draft's approval is bookkeeping. A proposal's approval is the
    // act itself, and it happens BEFORE anything is recorded — so a write that
    // fails leaves the card waiting, where the operator can see it and try
    // again. Recording an approval for a change that did not happen would be
    // the worst lie this surface could tell.
    let result = null;
    if ((item.type ?? "draft") === "event" && decision === "approve") {
      if (typeof execute !== "function") {
        throw new QueueRefused("This front door has no calendar-write path configured, so it will not pretend to make the change.");
      }
      result = await execute(item);
    }

    const state = await loadState(statePath);
    state.decisions[id] = {
      decision: decision === "approve" ? "approved" : "discarded",
      at: new Date().toISOString(),
    };
    if (result) {
      state.results[id] = {
        eventId: result.eventId ?? null,
        link: result.link ?? null,
        action: result.action === "update" ? "update" : "create",
        account: result.account === "work" ? "work" : "personal",
        at: result.at ?? new Date().toISOString(),
      };
    }
    prune(state);
    await saveState(statePath, state);
    return {
      id,
      decision: state.decisions[id].decision,
      at: state.decisions[id].at,
      result: state.results[id] ?? null,
    };
  });
}

// A draft this server watched go past in a chat reply. Deterministic: the card
// came out of the reply's own fenced block, and nothing was asked to remember it.
export function observeDraft({ statePath, card, desk }) {
  const subject = clean(card?.subject, 200);
  const to = clean(card?.to, 200);
  if (!subject && !to) return Promise.resolve(null);
  return serialise(async () => {
    const state = await loadState(statePath);
    const item = {
      id: `w-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      type: "draft",
      origin: "chat",
      source: `chat:${desk === "mail" ? "mail" : "coordinator"}`,
      account: accountOf(card?.account),
      to,
      subject,
      body: clean(card?.body, BODY_MAX) || null,
      at: new Date().toISOString(),
    };
    // The same draft announced twice in one conversation is one draft.
    if (state.observed.some((seen) => sameItem(seen, item))) return null;
    state.observed.push(item);
    prune(state);
    await saveState(statePath, state);
    return item.id;
  });
}

// An event PROPOSAL the same way — an agent asking, in the reply it was already
// making, for something to be put in the calendar. It is filed as a request and
// nothing else: the agent that emitted this card cannot reach the calendar
// writer, has no credential that could, and is not told what the operator did.
export function observeProposal({ statePath, card, desk }) {
  const item = {
    id: `v-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    type: "event",
    origin: "chat",
    action: card?.action === "update" ? "update" : "create",
    source: `chat:${desk === "mail" ? "mail" : "coordinator"}`,
    account: accountOf(card?.account),
    summary: clean(card?.summary ?? card?.title, 200),
    from: clean(card?.from, 60),
    to: clean(card?.to, 60),
    eventId: dashless(card?.eventId, 256),
    location: clean(card?.location, 200) || null,
    description: clean(card?.description, 2000) || null,
    attendees: Array.isArray(card?.attendees)
      ? splitAttendees(card.attendees.join(","))
      : splitAttendees(card?.attendees),
    why: clean(card?.why, 300) || null,
    at: new Date().toISOString(),
  };
  // A malformed proposal is dropped rather than shown. A card the operator
  // cannot act on is worse than no card: it invites a click that fails.
  if (!readableProposal(item)) return Promise.resolve(null);
  return serialise(async () => {
    const state = await loadState(statePath);
    if (state.observed.some((seen) => sameItem(seen, item))) return null;
    state.observed.push(item);
    prune(state);
    await saveState(statePath, state);
    return item.id;
  });
}

function prune(state) {
  if (state.observed.length > OBSERVED_MAX) {
    // Release answered cards first; age only breaks ties among those. A card
    // seen in chat carries its own draft text and has no PENDING.md line
    // behind it, so dropping an unanswered one loses it entirely.
    const overflow = state.observed.length - OBSERVED_MAX;
    const answered = state.observed.filter((item) => state.decisions[item.id]);
    if (answered.length) {
      const release = new Set(answered.slice(0, Math.min(overflow, answered.length)).map((i) => i.id));
      state.observed = state.observed.filter((item) => !release.has(item.id));
    }
    if (state.observed.length > OBSERVED_MAX) {
      state.observed = state.observed.slice(-OBSERVED_MAX);
    }
  }
  const ids = Object.keys(state.decisions);
  if (ids.length > DECISIONS_MAX) {
    // Oldest decisions go first. A pruned decision can only ever resurface as a
    // card, which is a nuisance and not a loss.
    ids
      .map((id) => [id, Date.parse(state.decisions[id].at) || 0])
      .sort((a, b) => a[1] - b[1])
      .slice(0, ids.length - DECISIONS_MAX)
      .forEach(([id]) => {
        delete state.decisions[id];
        delete state.results[id];
      });
  }
  const resultIds = Object.keys(state.results);
  if (resultIds.length > RESULTS_MAX) {
    resultIds
      .map((id) => [id, Date.parse(state.results[id].at) || 0])
      .sort((a, b) => a[1] - b[1])
      .slice(0, resultIds.length - RESULTS_MAX)
      .forEach(([id]) => delete state.results[id]);
  }
}
