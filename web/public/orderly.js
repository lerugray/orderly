// ORDERLY front door — the mark is the status light.
// Everything shown here comes from /api/status, which the server derives by
// actually asking the gateway. Nothing is assumed.

import { THEMES } from "./themes.js";

const el = (id) => document.getElementById(id);
const duty = el("duty");

// The default mark's own numbers, and the fallbacks for any mascot that does
// not carry its own. A variant's eye sits at its own size and height, so it
// states its closed-lid travel and both mouth shapes on the elements themselves.
const MOUTH_SMILE = "M13.5 23 Q16 25.5 18.5 23";
const MOUTH_FLAT = "M13.5 23.6 Q16 23.2 18.5 23.6";
const LID_CLOSE = 11;

// Whichever mascot the theme left visible is the instrument, and its moving
// parts are looked up again whenever it changes. Binding once at load bound the
// default mark forever — which is why a chosen variant sat there dead.
let mascot = null;
let pupil = null;
let lid = null;
let mouth = null;

function visibleMascot() {
  const all = [...document.querySelectorAll(".mascot")];
  return all.find((one) => !one.hasAttribute("hidden")) || all[0] || null;
}

function setMouth(on) {
  if (!mouth) return;
  mouth.setAttribute(
    "d",
    on
      ? mouth.getAttribute("data-mouth-smile") || MOUTH_SMILE
      : mouth.getAttribute("data-mouth-flat") || MOUTH_FLAT,
  );
}

function bindMascot(root) {
  mascot = root || null;
  pupil = root?.querySelector(".m-pupil") || null;
  lid = root?.querySelector(".m-lid") || null;
  mouth = root?.querySelector(".m-mouth") || null;
  // A mascot bound after the first status answer has to catch up to it.
  const state = duty?.dataset.state;
  if (state === "on" || state === "off") setMouth(state === "on");
}

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Station facts the chat needs; both are refreshed by every status poll.
let stationOnDuty = false;
let chatReady = true;

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function humanDuration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${plural(d, "day", "days")}, ${plural(h, "hour", "hours")}`;
  if (h) return `${plural(h, "hour", "hours")}, ${plural(m, "minute", "minutes")}`;
  return plural(m, "minute", "minutes");
}

function render(s) {
  const on = Boolean(s.onDuty);
  duty.dataset.state = on ? "on" : "off";
  setMouth(on);

  el("plate-text").textContent = on ? "On duty" : "Off post";

  if (on) {
    const up = s.service?.uptimeSeconds;
    el("duty-line").textContent = "He's at his post.";
    el("duty-sub").textContent = up
      ? `The gateway has been answering for ${humanDuration(up)}. Talk to him below, message him on Telegram, or open the console for the full panel.`
      : "The gateway is answering. Talk to him below, message him on Telegram, or open the console for the full panel.";
  } else {
    // A failure is a direction, not a mood: say what to do next.
    el("duty-line").textContent = "Nobody at the desk.";
    el("duty-sub").textContent =
      "The gateway isn't answering on this machine. Start the orderly-gateway service on the host, then reload this page.";
  }

  for (const id of ["console-link", "console-link-2"]) {
    const link = el(id);
    if (link && s.consoleUrl) link.href = s.consoleUrl;
  }

  const telegram = (s.channels || []).find((c) => c.id === "telegram");
  el("telegram-meta").textContent = telegram
    ? `Connected · ${telegram.policy === "allowlist" ? "one allowlisted operator" : String(telegram.policy || "configured")}`
    : "Not configured";

  el("r-gateway").textContent = on ? `answering · ${s.gateway?.status || "live"}` : "no answer";
  el("r-uptime").textContent = on ? humanDuration(s.service?.uptimeSeconds) : "—";
  el("r-model").textContent = s.model || "—";
  const agents = s.agents || [];
  const sandboxed = agents.filter((a) => a.sandboxed).length;
  el("r-agents").textContent = agents.length
    ? sandboxed === agents.length
      ? `${agents.length}, all sandboxed`
      : `${agents.length}, ${sandboxed} sandboxed`
    : "—";
  el("r-latency").textContent = Number.isFinite(s.gateway?.latencyMs)
    ? `${s.gateway.latencyMs} ms`
    : "—";
  el("r-checked").textContent = new Date(s.checkedAt || Date.now()).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  el("bar-where").textContent = location.hostname === "127.0.0.1" || location.hostname === "localhost"
    ? "Private station · tunnel"
    : "Private station · tailnet";

  stationOnDuty = on;
  chatReady = s.chat?.available !== false;
  updateComposer();
}

function unreachable() {
  render({ onDuty: false, channels: [], agents: [] });
  el("duty-sub").textContent =
    "This page can't reach its own status service. Check that orderly-web is running on the host, then reload.";
}

async function poll() {
  try {
    const res = await fetch("/api/status", { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    render(await res.json());
  } catch {
    unreachable();
  }
}

// --- the eye ---------------------------------------------------------------
//
// A chosen identity is not a repaint: the variant is inlined here so the page
// can reach its lid and pupil the way it reaches the default mark's. The file
// is only ever one the identity manifest names — never an attribute value taken
// on trust — and the parsed artwork is refused outright if it carries a script,
// a foreignObject, or an inline handler. Nothing executable arrives this way.

const MASCOT_FILES = new Set(THEMES.map((theme) => theme.mascot));

function safeMascotArtwork(text) {
  const parsed = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = parsed.documentElement;
  if (!root || root.nodeName !== "svg" || parsed.querySelector("parsererror")) return null;
  if (root.querySelector("script, foreignObject")) return null;
  for (const node of [root, ...root.querySelectorAll("*")]) {
    for (const attribute of node.attributes) {
      if (attribute.name.toLowerCase().startsWith("on")) return null;
      if (attribute.value.replace(/\s/g, "").toLowerCase().startsWith("javascript:")) return null;
    }
  }
  return root;
}

async function dressThemedMascot() {
  const slot = document.querySelector("[data-themed-mascot]");
  if (!slot || slot.hasAttribute("hidden")) return;
  const source = slot.getAttribute("data-mascot-src");
  if (!MASCOT_FILES.has(source) || slot.getAttribute("data-mascot-drawn") === source) return;
  try {
    const response = await fetch(source);
    if (!response.ok) throw new Error(String(response.status));
    const artwork = safeMascotArtwork(await response.text());
    if (!artwork) throw new Error("unusable mascot artwork");
    slot.replaceChildren(...artwork.childNodes);
    const box = artwork.getAttribute("viewBox");
    if (box) slot.setAttribute("viewBox", box);
    slot.setAttribute("data-mascot-drawn", source);
  } catch {
    // Never leave a hole where the status light goes: the default mark ships
    // inline and is always drawable, so fall back to it and say nothing.
    slot.toggleAttribute("hidden", true);
    document.querySelector("[data-default-mascot]")?.toggleAttribute("hidden", false);
  }
}

if (!reducedMotion) {
  const blink = () => {
    if (!lid || duty.dataset.state !== "on") return;
    const shut = lid;
    const travel = Number(shut.getAttribute("data-lid-close")) || LID_CLOSE;
    shut.style.transform = `translateY(${travel}px)`;
    setTimeout(() => {
      shut.style.transform = "";
    }, 130);
  };
  const scheduleBlink = () => {
    setTimeout(() => {
      blink();
      scheduleBlink();
    }, 3200 + Math.random() * 4800);
  };
  scheduleBlink();

  let frame = 0;
  window.addEventListener(
    "pointermove",
    (event) => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!pupil || !mascot) return;
        const box = mascot.getBoundingClientRect();
        if (!box.width) return;
        const dx = (event.clientX - (box.left + box.width / 2)) / box.width;
        const dy = (event.clientY - (box.top + box.height / 2)) / box.height;
        const clamp = (v) => Math.max(-1, Math.min(1, v * 1.4));
        pupil.style.transform = `translate(${(clamp(dx) * 1.5).toFixed(2)}px, ${(clamp(dy) * 1.2).toFixed(2)}px)`;
      });
    },
    { passive: true },
  );
}

bindMascot(visibleMascot());
void dressThemedMascot().then(() => bindMascot(visibleMascot()));

// --- the chat --------------------------------------------------------------
//
// Conversation goes to this page's own server, which holds the gateway
// credential. Nothing here ever sees a token. The gateway answers in prose, so
// results worth standing apart — inbox, calendar, drafts — are asked for as a
// fenced `orderly-card` JSON block, lifted out of the reply, and rendered in
// the rail. A reply without one is just a reply; the page never depends on it.

const thread = el("thread");
const threadEmpty = el("thread-empty");
const composer = el("composer");
const ask = el("ask");
const sendBtn = el("send");
const sendText = el("send-text");
const railStack = el("rail-stack");
const railEmpty = el("rail-empty");
const deskNote = el("desk-note");
const deskOpts = () => Array.from(document.querySelectorAll(".desks__opt"));

const DESK_COPY = {
  coordinator: {
    label: "Coordinator",
    note:
      "The coordinator handles anything and hands the work to a specialist — the mail agent, " +
      "or the researcher for anything on the web. He answers straight away to say he's asked, " +
      "and carries the result back here when you ask again.",
    hint: "Enter sends · Shift and Enter for a new line",
  },
  mail: {
    label: "Mail desk",
    note:
      "The mail agent itself, asked directly, so inbox and calendar answers come back here " +
      "rather than on Telegram. It reads and drafts. It cannot send.",
    hint: "Enter sends · he reads and drafts, he never sends",
  },
};

// --- named agents (spec §3.1) ----------------------------------------------
//
// One desk per active named agent, keyed `agent:<id>` — the immutable id, never
// the handle, because a rename must not move a thread. Their conversations do
// NOT live in this browser: the station owns each transcript, so a named desk
// survives a reload, a cleared browser and a different machine on the tailnet,
// which is exactly what the fixed desks do not do and have never claimed to.
const AGENT_DESK = /^agent:(a-[a-z0-9]{8,40})$/;
const namedAgents = new Map(); // desk key -> the sanitised record
const hydrated = new Set(); // desk keys whose transcript has been fetched

function agentIdFor(key) {
  return AGENT_DESK.exec(key)?.[1] ?? null;
}

let desk = "coordinator";
let busy = false;
// One thread per desk: the desks are separate sessions upstream, and mixing
// their histories would hand one agent the other's transcript.
const histories = { coordinator: [], mail: [] };

// --- where threads live ----------------------------------------------------
//
// In this browser, and nowhere else. The station stores nothing on your behalf:
// every request upstream is a fresh session and the page carries the history,
// so if the page forgets, the conversation is gone. That is why closing a
// thread archives it rather than deleting it — and why the archive is honest
// about its ceiling, because localStorage is a few megabytes, not a filing
// cabinet. Nothing here makes the assistant remember anything; it makes the
// page remember, which is a different and much smaller claim.

const STORE_KEY = "orderly.chat.v1";
const ARCHIVE_MAX = 40;
const TITLE_MAX = 72;

// Each desk also carries a thread id, which the server turns into a session key
// upstream. That is what lets a desk collect work it handed to a specialist:
// the result comes back to the session that spawned it, so a desk that forgot
// its session could be told "I've asked the researcher" and then have nowhere to
// go and ask. Archiving retires the id along with the words, so a cleared desk
// is genuinely a fresh conversation on both sides — and restoring brings both
// back together.
const threads = { coordinator: "", mail: "" };

function newThreadId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.replace(/[^a-z0-9]/g, "").slice(0, 40);
}

function threadFor(which) {
  if (!/^[a-z0-9]{4,40}$/.test(threads[which] || "")) {
    threads[which] = newThreadId();
    saveStore();
  }
  return threads[which];
}

const archive = [];
let storageWorks = true;
let storageTrimmed = false;
let viewing = null; // an archived entry being read, or null for the live thread

function newId() {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function cleanTurns(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const turn of value) {
    const role = turn?.role === "user" ? "user" : turn?.role === "assistant" ? "assistant" : null;
    if (!role || typeof turn?.content !== "string") continue;
    out.push({ role, content: turn.content });
  }
  return out;
}

function loadStore() {
  let saved;
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return;
    saved = JSON.parse(raw);
  } catch {
    // Unreadable or unavailable (private mode, storage disabled): start clean
    // and say so rather than pretending threads will survive a reload.
    storageWorks = false;
    return;
  }
  for (const id of ["coordinator", "mail"]) {
    histories[id] = cleanTurns(saved?.live?.[id]);
    const thread = saved?.threads?.[id];
    threads[id] = typeof thread === "string" && /^[a-z0-9]{4,40}$/.test(thread) ? thread : "";
  }
  if (Array.isArray(saved?.archive)) {
    for (const entry of saved.archive.slice(0, ARCHIVE_MAX)) {
      const turns = cleanTurns(entry?.turns);
      if (!turns.length) continue;
      const thread = entry?.thread;
      archive.push({
        id: typeof entry?.id === "string" ? entry.id : newId(),
        desk: DESK_COPY[entry?.desk] ? entry.desk : "coordinator",
        title: typeof entry?.title === "string" ? entry.title : "(untitled)",
        at: Number.isFinite(entry?.at) ? entry.at : Date.now(),
        thread: typeof thread === "string" && /^[a-z0-9]{4,40}$/.test(thread) ? thread : "",
        turns,
      });
    }
  }
}

function saveStore() {
  if (!storageWorks) return;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      window.localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          v: 1,
          // The two fixed desks and no more: a named agent's transcript belongs
          // to the station (spec §4.1), and a second copy in this browser could
          // only ever disagree with it.
          live: { coordinator: histories.coordinator, mail: histories.mail },
          threads,
          archive,
        }),
      );
      return;
    } catch {
      // Out of room. Drop the oldest archived thread and try again — the live
      // conversation is what you are actually using, so it is the last to go.
      if (archive.length) {
        archive.pop();
        storageTrimmed = true;
        continue;
      }
      storageWorks = false;
      drawArchive();
      return;
    }
  }
}

function titleFor(turns) {
  const first = turns.find((t) => t.role === "user");
  const line = String(first?.content || "")
    .split("\n")
    .map((s) => s.trim())
    .find(Boolean);
  if (!line) return "(no words)";
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

function stamp(at) {
  const when = new Date(at);
  return `${when.toLocaleDateString([], { month: "short", day: "numeric" })} · ${when.toLocaleTimeString(
    [],
    { hour: "2-digit", minute: "2-digit" },
  )}`;
}

// Archiving is the only way a thread leaves the live desk, so it is also the
// only thing "clear" does. Deleting stays a separate, confirmed act.
function archiveThread(which) {
  const turns = histories[which];
  if (!turns.length) return false;
  archive.unshift({
    id: newId(),
    desk: which,
    title: titleFor(turns),
    at: Date.now(),
    thread: threads[which] || "",
    turns: turns.slice(),
  });
  while (archive.length > ARCHIVE_MAX) {
    archive.pop();
    storageTrimmed = true;
  }
  histories[which] = [];
  threads[which] = ""; // retired with the words; the next question starts a new one
  saveStore();
  return true;
}

function updateComposer() {
  const blocked = busy || !stationOnDuty || !chatReady || Boolean(viewing);
  ask.disabled = blocked;
  sendBtn.disabled = blocked;
  sendText.textContent = busy ? "Sending…" : "Send";
  if (!chatReady) {
    el("composer-hint").textContent =
      "This front door has no gateway credential, so it can't pass messages on.";
  } else if (!stationOnDuty) {
    el("composer-hint").textContent = "Nobody at the desk — the gateway isn't answering.";
  } else if (viewing) {
    el("composer-hint").textContent =
      "You're reading an archived thread. Close it or restore it to talk again.";
  } else {
    el("composer-hint").textContent = DESK_COPY[desk].hint;
  }
  const archiveBtn = el("thread-archive");
  if (archiveBtn) {
    archiveBtn.disabled =
      Boolean(agentIdFor(desk)) || Boolean(viewing) || busy || !(histories[desk] ?? []).length;
  }
  if (typeof updateDay === "function") updateDay();
}

function setDesk(next) {
  if (busy || !DESK_COPY[next]) return;
  desk = next;
  histories[next] ??= [];
  viewing = null;
  if (agentIdFor(next) && !hydrated.has(next)) hydrateAgentThread(next);
  drawReading();
  for (const opt of deskOpts()) {
    const on = opt.dataset.desk === desk;
    opt.classList.toggle("is-on", on);
    opt.setAttribute("aria-checked", String(on));
  }
  deskNote.textContent = DESK_COPY[desk].note;
  drawThread();
  drawArchive();
  updateComposer();
}

// --- prose ---
// Model output is never trusted as markup. Paragraphs, **bold** and links are
// honoured by building nodes; everything else stays literal text.
//
// A link is the one place a model's output becomes something you can click, so
// it is the one place worth being pedantic: the href is parsed by the URL
// constructor and kept only if it comes out http or https, and the visible text
// is always a text node — never the model's markup, and for a bare URL never
// anything but the URL itself, so the label cannot disagree with the target.

// Models wrap URLs in backticks, quotes and brackets constantly, and a swallowed
// delimiter is a dead link — so the delimiters are excluded from the URL itself
// and any trailing punctuation is handed back to the sentence as plain text.
const LINK_PATTERN = /(\[[^\]\n]{1,120}\]\((?:https?:\/\/)[^\s()<>`]{1,500}\)|(?:https?:\/\/)[^\s<>\[\]"'`*]{2,500})/g;
const TRAILING_JUNK = /[.,;:!?\]}>"'`*]+$/;

// Wikipedia and friends put parentheses inside real URLs, and models put real
// URLs inside parentheses. Keep the ones the URL opened; give back the rest.
function trimTail(url) {
  let out = url.replace(TRAILING_JUNK, "");
  for (;;) {
    if (!out.endsWith(")")) break;
    const opens = (out.match(/\(/g) || []).length;
    const closes = (out.match(/\)/g) || []).length;
    if (closes <= opens) break;
    out = out.slice(0, -1).replace(TRAILING_JUNK, "");
  }
  return out;
}

function safeHref(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
}

function appendLinked(parent, text) {
  for (const piece of String(text).split(LINK_PATTERN)) {
    if (!piece) continue;
    let target = piece;
    let label = piece;
    const markdown = /^\[([^\]\n]+)\]\((https?:\/\/[^\s()<>]+)\)$/.exec(piece);
    if (markdown) {
      label = markdown[1];
      target = markdown[2];
    } else if (!/^https?:\/\//i.test(piece)) {
      parent.appendChild(document.createTextNode(piece));
      continue;
    } else {
      // A bare URL often ends a sentence; the punctuation is not part of it.
      target = trimTail(target);
      label = target;
    }
    const href = safeHref(target);
    if (!href) {
      parent.appendChild(document.createTextNode(piece));
      continue;
    }
    const anchor = document.createElement("a");
    anchor.className = "turn__link";
    anchor.href = href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer nofollow";
    anchor.textContent = label;
    parent.appendChild(anchor);
    if (!markdown && piece.length > target.length) {
      parent.appendChild(document.createTextNode(piece.slice(target.length)));
    }
  }
}

function writeProse(node, text) {
  node.textContent = "";
  const blocks = String(text).split(/\n{2,}/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const p = document.createElement("p");
    const lines = block.split("\n");
    lines.forEach((line, i) => {
      if (i) p.appendChild(document.createElement("br"));
      for (const piece of line.split(/(\*\*[^*]+\*\*)/g)) {
        if (!piece) continue;
        if (piece.startsWith("**") && piece.endsWith("**") && piece.length > 4) {
          const strong = document.createElement("strong");
          appendLinked(strong, piece.slice(2, -2));
          p.appendChild(strong);
        } else {
          appendLinked(p, piece);
        }
      }
    });
    node.appendChild(p);
  }
  if (!node.childNodes.length) node.appendChild(document.createElement("p"));
}

// --- cards ---
// Split a reply into what to say and what to stand apart. An unterminated block
// mid-stream is withheld rather than shown half-formed as raw JSON.
const CARD_OPEN = "```orderly-card";

function splitReply(raw) {
  let prose = "";
  let cards = [];
  let i = 0;
  for (;;) {
    const open = raw.indexOf(CARD_OPEN, i);
    if (open === -1) {
      let tail = raw.slice(i);
      // hide a fence that is still being typed
      for (let n = CARD_OPEN.length - 1; n > 0; n--) {
        if (tail.endsWith(CARD_OPEN.slice(0, n))) {
          tail = tail.slice(0, -n);
          break;
        }
      }
      prose += tail;
      break;
    }
    prose += raw.slice(i, open);
    const bodyStart = raw.indexOf("\n", open);
    const close = bodyStart === -1 ? -1 : raw.indexOf("```", bodyStart);
    if (close === -1) break; // incomplete: withhold the rest
    try {
      cards.push(JSON.parse(raw.slice(bodyStart + 1, close)));
    } catch {
      /* a malformed block is dropped; the prose still stands */
    }
    i = close + 3;
  }
  return { prose: prose.trim(), cards };
}

function add(parent, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  parent.appendChild(node);
  return node;
}

const KIND_LABEL = { inbox: "Inbox", calendar: "Calendar", draft: "Draft" };

function buildCard(card) {
  const kind = KIND_LABEL[card?.kind] ? card.kind : null;
  if (!kind) return null;

  const box = document.createElement("article");
  box.className = "result";

  const head = add(box, "div", "result__head");
  add(head, "span", "result__kind", KIND_LABEL[kind]);
  add(
    head,
    "span",
    "result__when",
    new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  );

  if (typeof card.title === "string" && card.title.trim()) {
    add(box, "h3", "result__title", card.title.trim());
  }

  if (kind === "inbox" || kind === "calendar") {
    const items = Array.isArray(card.items) ? card.items.slice(0, 12) : [];
    if (!items.length) return null;
    const list = add(box, "ul", "result__list");
    for (const item of items) {
      const row = add(list, "li", "item");
      if (kind === "inbox") {
        if (item?.needsYou === true) row.classList.add("item--flag");
        add(row, "span", "item__from", item?.from || "Unknown sender");
        add(row, "span", "item__subject", item?.subject || "(no subject)");
        if (item?.summary) add(row, "span", "item__summary", item.summary);
        if (item?.needsYou === true) add(row, "span", "item__flag", "Needs you");
      } else {
        add(row, "span", "item__from", item?.when || "—");
        add(row, "span", "item__subject", item?.title || "(untitled)");
        if (item?.detail) add(row, "span", "item__summary", item.detail);
      }
    }
    const foot = add(box, "p", "result__foot");
    add(foot, "span", "chip chip--read", "Read only");
    add(foot, "span", null, kind === "inbox" ? "He read it. He cannot send." : "He read your calendar.");
    return box;
  }

  // draft
  const fields = add(box, "dl", "result__field");
  add(fields, "dt", null, "To");
  add(fields, "dd", null, card.to || "—");
  add(fields, "dt", null, "Subject");
  add(fields, "dd", null, card.subject || "—");
  add(box, "div", "result__body", card.body || "");
  const foot = add(box, "p", "result__foot");
  add(foot, "span", "chip chip--draft", "Drafts only");
  add(foot, "span", null, "It's in your Gmail drafts. You press send.");
  return box;
}

function landCards(cards) {
  let landed = 0;
  for (const card of cards) {
    const node = buildCard(card);
    if (!node) continue;
    railStack.insertBefore(node, railStack.firstChild);
    landed += 1;
  }
  if (landed) railEmpty.hidden = true;
}

// --- thread ---

// The coordinator hands work to a specialist and answers straight away with an
// acknowledgement — that is the transport, not a bug. The gateway's
// OpenAI-compatible stream carries content only, no tool or spawn events, so
// there is no honest way to show "asking the researcher…" while it happens.
// What IS knowable is what the reply says it did: when the last thing he said
// was "I've asked the researcher, I'll relay it", the page offers to go and ask
// rather than leaving you to type the follow-up yourself.
// Two shapes, because he says it both ways: "I've asked the researcher" on the
// first answer, and "still running, I'll relay it" on the second. The follow-up
// has to survive the second, since that is precisely when you still need it.
const SPECIALIST = /\b(researcher|research agent|mail agent|mail desk)\b/i;
const HANDED_OVER = /\b(asked|sent|handed|passed|spawned|delegat\w*|dispatch\w*|tasked)\b/i;
const STILL_WAITING = /\b(not yet|still (running|working|going)|hasn't (reported|come back|finished)|waiting on|as soon as|the moment it|when it reports|i'?ll relay)\b/i;

function pendingHandoff(turns) {
  const last = turns[turns.length - 1];
  if (!last || last.role !== "assistant") return null;
  const prose = splitReply(last.content).prose || last.content;
  const who = SPECIALIST.exec(prose);
  if (!who) return null;
  if (!HANDED_OVER.test(prose) && !STILL_WAITING.test(prose)) return null;
  // If the answer already carries links, there is nothing left to chase.
  if (/https?:\/\//i.test(prose)) return null;
  return /research/i.test(who[1]) ? "researcher" : "mail agent";
}

function drawNudge(who) {
  const node = add(thread, "div", "nudge");
  add(node, "span", "nudge__text", `Waiting on the ${who}. He answers here once it reports back.`);
  const go = add(node, "button", "ghost nudge__go", "Ask if it's back");
  go.type = "button";
  go.addEventListener("click", () => {
    if (busy || viewing || !stationOnDuty || !chatReady) return;
    send(`Has the ${who} reported back yet? If so, give me exactly what it returned, links verbatim.`);
  });
}

function drawThread() {
  thread.textContent = "";
  const log = viewing ? viewing.turns : (histories[desk] ?? []);
  const label = viewing ? DESK_COPY[viewing.desk].label : DESK_COPY[desk].label;
  if (!log.length) {
    thread.appendChild(threadEmpty);
    threadEmpty.hidden = false;
    return;
  }
  threadEmpty.hidden = true;
  for (const turn of log) {
    const node = document.createElement("div");
    node.className = turn.role === "user" ? "turn turn--you" : "turn turn--him";
    if (turn.role !== "user") add(node, "span", "turn__who", label);
    const body = document.createElement("div");
    writeProse(body, splitReply(turn.content).prose || turn.content);
    node.appendChild(body);
    thread.appendChild(node);
  }
  if (!viewing && !busy) {
    const who = pendingHandoff(log);
    if (who) drawNudge(who);
  }
  thread.scrollTop = thread.scrollHeight;
}

// --- the archive -----------------------------------------------------------

function drawArchive() {
  const list = el("archive-list");
  const note = el("archive-note");
  const toggle = el("archive-toggle");
  const bar = el("threadbar-note");
  if (!list || !note || !toggle) return;

  toggle.textContent = archive.length ? `Archive (${archive.length})` : "Archive";
  el("thread-archive").disabled =
    Boolean(agentIdFor(desk)) || Boolean(viewing) || busy || !(histories[desk] ?? []).length;

  bar.textContent = agentIdFor(desk)
    ? "This thread is kept on the station, so it survives a reload and a cleared browser."
    : storageWorks
      ? "Threads are kept in this browser only — never on the station."
      : "This browser won't keep threads: storage is unavailable, so a reload loses the conversation.";

  list.textContent = "";
  if (!archive.length) {
    note.textContent = storageWorks
      ? "Nothing archived yet. Archiving clears the desk without throwing the conversation away."
      : "Nothing can be archived while this browser's storage is unavailable.";
    return;
  }
  note.textContent = storageTrimmed
    ? `Holding ${archive.length} of at most ${ARCHIVE_MAX} threads. The oldest were dropped to stay inside this browser's storage.`
    : `Holding ${archive.length} of at most ${ARCHIVE_MAX} threads, in this browser only.`;

  for (const entry of archive) {
    const row = add(list, "li", "arch");
    const head = add(row, "div", "arch__head");
    add(head, "span", "arch__title", entry.title);
    add(head, "span", "arch__meta", `${DESK_COPY[entry.desk].label} · ${stamp(entry.at)} · ${entry.turns.length} messages`);
    const acts = add(row, "span", "arch__acts");

    const open = add(acts, "button", "ghost", viewing?.id === entry.id ? "Reading" : "Read");
    open.type = "button";
    open.disabled = viewing?.id === entry.id;
    open.addEventListener("click", () => openArchived(entry.id));

    const back = add(acts, "button", "ghost", "Restore");
    back.type = "button";
    back.disabled = busy;
    back.addEventListener("click", () => restoreArchived(entry.id));

    const gone = add(acts, "button", "ghost arch__del", "Delete");
    gone.type = "button";
    gone.addEventListener("click", () => deleteArchived(entry.id));
  }
}

function drawReading() {
  const bar = el("reading");
  if (!bar) return;
  bar.hidden = !viewing;
  if (viewing) {
    el("reading-text").textContent =
      `Reading an archived thread — ${DESK_COPY[viewing.desk].label}, ${stamp(viewing.at)}. Nothing you type goes here.`;
  }
}

function openArchived(id) {
  const entry = archive.find((e) => e.id === id);
  if (!entry) return;
  viewing = entry;
  drawReading();
  drawThread();
  drawArchive();
  updateComposer();
}

function closeArchived() {
  viewing = null;
  drawReading();
  drawThread();
  drawArchive();
  updateComposer();
}

// Restoring never overwrites: whatever is live on that desk is archived first,
// so the two threads swap places rather than one landing on top of the other.
function restoreArchived(id) {
  if (busy) return;
  const index = archive.findIndex((e) => e.id === id);
  if (index === -1) return;
  const entry = archive[index];
  archiveThread(entry.desk);
  const stillThere = archive.findIndex((e) => e.id === id);
  if (stillThere !== -1) archive.splice(stillThere, 1);
  histories[entry.desk] = entry.turns.slice();
  threads[entry.desk] = entry.thread || "";
  viewing = null;
  saveStore();
  setDesk(entry.desk);
  drawReading();
  drawArchive();
}

function deleteArchived(id) {
  const entry = archive.find((e) => e.id === id);
  if (!entry) return;
  const sure = window.confirm(
    `Delete "${entry.title}" for good?\n\n${DESK_COPY[entry.desk].label} · ${stamp(entry.at)} · ${entry.turns.length} messages.\nThis cannot be undone.`,
  );
  if (!sure) return;
  const index = archive.findIndex((e) => e.id === id);
  if (index !== -1) archive.splice(index, 1);
  if (viewing?.id === id) viewing = null;
  saveStore();
  drawReading();
  drawThread();
  drawArchive();
  updateComposer();
}

function pendingTurn() {
  threadEmpty.hidden = true;
  const node = document.createElement("div");
  node.className = "turn turn--him";
  add(node, "span", "turn__who", DESK_COPY[desk].label);
  const body = document.createElement("div");
  const dots = add(body, "span", "think");
  add(dots, "span");
  add(dots, "span");
  add(dots, "span");
  node.appendChild(body);
  thread.appendChild(node);
  thread.scrollTop = thread.scrollHeight;
  return body;
}

function fault(message) {
  const node = document.createElement("div");
  node.className = "turn turn--fault";
  node.textContent = message;
  thread.appendChild(node);
  thread.scrollTop = thread.scrollHeight;
}

// --- sending ---

async function send(text) {
  const at = desk;
  viewing = null;
  drawReading();
  histories[at].push({ role: "user", content: text });
  saveStore();
  busy = true;
  updateComposer();
  drawThread();
  const body = pendingTurn();

  let raw = "";
  let ok = false;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        agentIdFor(at)
          ? {
              // The station holds this agent's session AND its transcript, so a
              // handful of turns is plenty — and stays well inside the front
              // door's own conversation caps however long the thread has grown.
              agent: agentIdFor(at),
              stream: true,
              messages: histories[at].slice(-8),
            }
          : { desk: at, thread: threadFor(at), stream: true, messages: histories[at] },
      ),
    });

    if (!res.ok) {
      let why = `The station answered ${res.status}.`;
      try {
        const problem = await res.json();
        if (problem?.error) why = problem.error;
      } catch {
        /* keep the status line */
      }
      throw new Error(why);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        for (const line of part.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let chunk;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          const delta = chunk?.choices?.[0]?.delta?.content;
          if (typeof delta !== "string" || !delta) continue;
          raw += delta;
          writeProse(body, splitReply(raw).prose || "…");
          thread.scrollTop = thread.scrollHeight;
        }
      }
    }
    ok = true;
  } catch (err) {
    body.parentElement?.remove();
    fault(String(err?.message || "The station couldn't be reached."));
  }

  if (ok) {
    const { prose, cards } = splitReply(raw);
    if (!prose && !cards.length) {
      body.parentElement?.remove();
      fault("He answered with nothing. Try asking again.");
    } else {
      histories[at].push({ role: "assistant", content: raw });
      saveStore();
      writeProse(body, prose || "(no words, but see the card)");
      landCards(cards);
    }
  }

  busy = false;
  updateComposer();
  if (ok && at === desk && !viewing) drawThread();
  drawArchive();
  thread.scrollTop = thread.scrollHeight;
}

// --- wiring ---

function wireDesk(opt) {
  opt.addEventListener("click", () => setDesk(opt.dataset.desk));
}
for (const opt of deskOpts()) wireDesk(opt);

// --- the named-agent desks -------------------------------------------------
//
// §3.1: one entry per ACTIVE named agent, routed by immutable id. A pending or
// suspended identity is deliberately absent — it is managed on /agents, and a
// desk button for something that would refuse to answer is worse than none.

async function loadAgents() {
  let roster;
  try {
    const res = await fetch("/api/agents", { headers: { Accept: "application/json" } });
    roster = await res.json();
  } catch {
    return; // no roster is the station as it has always been
  }
  const active = (roster?.agents || []).filter((agent) => agent.lifecycle === "active");
  const strip = document.querySelector(".desks");
  const note = deskNote;
  if (!strip) return;

  for (const agent of active) {
    const key = `agent:${agent.id}`;
    namedAgents.set(key, agent);
    histories[key] ??= [];
    DESK_COPY[key] = {
      label: agent.name,
      note:
        (agent.description ? `${agent.description} ` : "") +
        "Its own conversation, kept on the station. It holds no credential, no mailbox and no " +
        "delegation — if you need mail, the calendar or the web, ask the coordinator.",
      hint: "Enter sends · this thread is kept on the station",
    };
    if (strip.querySelector(`[data-desk="${key}"]`)) continue;
    const button = document.createElement("button");
    button.className = "desks__opt";
    button.type = "button";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", "false");
    button.dataset.desk = key;
    button.textContent = agent.name;
    strip.insertBefore(button, note);
    wireDesk(button);
  }

  // Outside the radiogroup, deliberately: a focusable link among the radios
  // would be one more stop in the arrow-key cycle that answers to none of them.
  if (active.length && !document.querySelector(".desks__manage")) {
    const link = document.createElement("a");
    link.className = "desks__manage";
    link.href = "/agents";
    link.textContent = "Manage agents";
    strip.insertAdjacentElement("afterend", link);
  }
}

// The station's copy is the copy. It is read once per desk and then kept in
// step by what this page sends and receives, so opening an agent does not cost
// a round trip every time.
async function hydrateAgentThread(key) {
  const id = agentIdFor(key);
  if (!id) return;
  hydrated.add(key);
  try {
    const res = await fetch(`/api/agents/thread?agent=${encodeURIComponent(id)}`, {
      headers: { Accept: "application/json" },
    });
    const payload = await res.json();
    const turns = cleanTurns(payload?.turns);
    if (!turns.length) return;
    // Anything typed while the fetch was in flight stays at the end of the
    // thread rather than being replaced by the station's older view.
    const live = histories[key] ?? [];
    const known = new Set(turns.map((turn) => `${turn.role}:${turn.content}`));
    histories[key] = [...turns, ...live.filter((turn) => !known.has(`${turn.role}:${turn.content}`))];
    if (desk === key && !viewing) drawThread();
  } catch {
    // A transcript that cannot be read leaves the thread empty rather than
    // wrong; the next thing said is still recorded on the station.
  }
}

loadAgents();

el("thread-archive")?.addEventListener("click", () => {
  if (busy || viewing) return;
  if (!archiveThread(desk)) return;
  drawThread();
  drawArchive();
  updateComposer();
});

el("archive-toggle")?.addEventListener("click", () => {
  const panel = el("archive");
  const open = panel.hidden;
  panel.hidden = !open;
  el("archive-toggle").setAttribute("aria-expanded", String(open));
});

el("reading-close")?.addEventListener("click", closeArchived);
el("reading-restore")?.addEventListener("click", () => {
  if (viewing) restoreArchived(viewing.id);
});

for (const starter of document.querySelectorAll(".starter")) {
  starter.addEventListener("click", () => {
    if (busy) return;
    if (starter.dataset.desk) setDesk(starter.dataset.desk);
    ask.value = starter.textContent.trim();
    ask.focus();
    grow();
  });
}

function grow() {
  ask.style.height = "auto";
  ask.style.height = `${Math.min(ask.scrollHeight, 144)}px`;
}
ask.addEventListener("input", grow);

ask.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = ask.value.trim();
  if (!text || busy || !stationOnDuty || !chatReady) return;
  ask.value = "";
  grow();
  send(text);
});

// --- the day ---------------------------------------------------------------
//
// A standing agenda instead of asking the chat the same question each morning.
// It goes through /api/agenda, which asks the mail desk — already sandboxed,
// already read-only against the calendar — and caches the answer server-side so
// reopening the page doesn't quietly spend another model call. Nothing here
// reaches a capability the chat didn't already have.

const dayBtn = el("day-check");
const dayList = el("day-list");
const dayNote = el("day-note");
const dayWhen = el("day-when");
let dayBusy = false;

function updateDay() {
  if (!dayBtn) return;
  dayBtn.disabled = dayBusy || !stationOnDuty || !chatReady;
  dayBtn.textContent = dayBusy ? "Reading…" : dayList.hidden ? "Check the calendar" : "Check again";
}

function drawDay(payload) {
  if (payload?.error) {
    dayNote.textContent = payload.error;
    dayWhen.textContent = "couldn't check";
    return;
  }
  if (!payload || payload.state === "empty") return;

  dayList.textContent = "";
  const items = Array.isArray(payload.items) ? payload.items : [];
  for (const [index, item] of items.entries()) {
    const row = add(dayList, "li", index === 0 ? "day__row day__row--next" : "day__row");
    add(row, "span", "day__when-cell", item.when || "—");
    const body = add(row, "span", null);
    add(body, "span", "day__title", item.title || "(untitled)");
    if (item.detail) add(body, "span", "day__detail", item.detail);
  }
  dayList.hidden = items.length === 0;

  dayNote.textContent = items.length
    ? payload.note || ""
    : payload.note || "Nothing scheduled in the next seven days.";
  const at = payload.at ? new Date(payload.at) : null;
  dayWhen.textContent = at
    ? `${payload.state === "stale" ? "as of" : "checked"} ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : "";
}

async function checkDay(refresh) {
  if (dayBusy) return;
  dayBusy = refresh;
  updateDay();
  try {
    const res = await fetch("/api/agenda", { method: refresh ? "POST" : "GET", cache: "no-store" });
    drawDay(await res.json());
  } catch {
    if (refresh) dayNote.textContent = "Couldn't reach the station to ask.";
  }
  dayBusy = false;
  updateDay();
}

if (dayBtn) {
  dayBtn.addEventListener("click", () => checkDay(true));
  // A cached answer from an earlier visit costs nothing to show.
  checkDay(false);
}

// --- reminders -------------------------------------------------------------
//
// Read-only, and cheap: /api/reminders opens the file the coordinator writes
// and parses it. No model call, so unlike the day it can just load. There is
// no control here on purpose — scheduling a reminder is owner-gated at the
// gateway and this page is not the owner, so the honest surface is the list
// itself and a line saying where to change it.

const dueList = el("due-list");
const dueNote = el("due-note");
const dueWhen = el("due-when");

// The store keeps a full offset timestamp because the scheduler needs one; a
// person reading the page does not. Anything unparseable is shown verbatim
// rather than guessed at — a due date the station got wrong should look wrong.
function dueLabel(item) {
  if (!item.due || item.due.toLowerCase() === "someday") return "someday";
  if (!Number.isFinite(item.at)) return item.due;
  const when = new Date(item.at);
  const time = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const today = new Date();
  const sameDay =
    when.getFullYear() === today.getFullYear() &&
    when.getMonth() === today.getMonth() &&
    when.getDate() === today.getDate();
  if (sameDay) return `today ${time}`;
  return `${when.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ${time}`;
}

function drawDue(payload) {
  if (!dueList) return;
  const open = Array.isArray(payload?.open) ? payload.open : [];
  dueList.textContent = "";
  for (const item of open) {
    const row = add(dueList, "li", item.overdue ? "day__row day__row--next" : "day__row");
    add(row, "span", "day__when-cell", dueLabel(item));
    const body = add(row, "span", null);
    add(body, "span", "day__title", item.text || "(blank)");
    if (item.overdue) add(body, "span", "day__detail", "overdue");
  }
  dueList.hidden = open.length === 0;

  if (payload?.state === "absent") {
    dueNote.textContent = "No list yet. Ask him on Telegram to remember something.";
    dueWhen.textContent = "";
    return;
  }
  dueNote.textContent = open.length
    ? "Ask him on Telegram to add one or tick one off — this page only reads the list."
    : "Nothing outstanding.";
  const done = Number(payload?.done) || 0;
  dueWhen.textContent = open.length
    ? `${open.length} open${done ? `, ${done} done` : ""}${payload?.truncated ? ", more not shown" : ""}`
    : done
      ? `${done} done`
      : "empty";
}

async function checkDue() {
  if (!dueList) return;
  try {
    const res = await fetch("/api/reminders", { cache: "no-store" });
    drawDue(await res.json());
  } catch {
    dueWhen.textContent = "couldn't read";
    dueNote.textContent = "Couldn't reach the station to read the list.";
  }
}

if (dueList) {
  checkDue();
  setInterval(checkDue, 60000);
}

// --- the approval queue ----------------------------------------------------
//
// Drafts the agents made, waiting for a decision. Reading costs nothing — a file
// and a small store on the station, no model call — so this polls like the
// reminders do. Deciding posts one word back and gets the whole queue in reply,
// so two tabs cannot disagree for long.
//
// The verbs are honest and the page says so out loud: approving records that the
// operator read it and kept it. It does not send. Nothing here can send, and a
// button that implied otherwise would be the single worst thing this surface
// could do.

const queueStack = el("queue-stack");
const queueNote = el("queue-note");
const queueWhen = el("queue-when");
const queueRecent = el("queue-recent");
let queueBusy = false;
let queueCanWrite = true;

const QUEUE_NOTE =
  "Work he has finished, held here until you say. A draft is kept, never sent — sending is " +
  "switched off underneath, so the last move is yours in Gmail. A calendar proposal is the " +
  "opposite: approving it creates or changes the event immediately.";

function sourceLabel(item) {
  if (item.origin === "chat") {
    return item.source === "chat:mail" ? "you asked at the mail desk" : "you asked the coordinator";
  }
  if (typeof item.source === "string" && item.source.startsWith("t-")) {
    return `routine ${item.source}`;
  }
  return item.source ? `from ${item.source}` : "written for you";
}

function whenLabel(at) {
  const when = Date.parse(at ?? "");
  if (!Number.isFinite(when)) return "";
  const day = new Date(when);
  const today = new Date();
  const same =
    day.getFullYear() === today.getFullYear() &&
    day.getMonth() === today.getMonth() &&
    day.getDate() === today.getDate();
  const time = day.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return same ? time : `${day.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

// A readable window for a proposal: "Mon 25 Aug, 2:00pm – 3:00pm", falling back
// to whatever the agent wrote if it isn't a date this browser understands. The
// station has already refused anything without a timezone offset, so a value
// that parses here is the same instant the calendar will get.
function spanLabel(from, to) {
  const a = new Date(from);
  const b = new Date(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return `${from} → ${to}`;
  const day = a.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  const start = a.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const end = b.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = a.toDateString() === b.toDateString();
  return sameDay
    ? `${day}, ${start} – ${end}`
    : `${day} ${start} → ${b.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} ${end}`;
}

// The event card. Deliberately unlike the draft card in colour, in the word on
// the button, and in which direction asks for a confirm — because the two
// approvals do opposite things and a page that rendered them alike would be
// inviting the mistake.
function buildProposalCard(item) {
  const box = document.createElement("article");
  box.className = "result queue__card queue__card--event";

  const head = add(box, "div", "result__head");
  add(
    head,
    "span",
    "result__kind result__kind--act",
    item.action === "update" ? "Calendar change" : "New event",
  );
  add(head, "span", "result__when", whenLabel(item.at));

  if (item.summary) add(box, "h3", "result__title", item.summary);

  const fields = add(box, "dl", "result__field");
  add(fields, "dt", null, "When");
  add(fields, "dd", null, spanLabel(item.from, item.to));
  add(fields, "dt", null, "Calendar");
  add(fields, "dd", null, item.account ? `your ${item.account} calendar` : "not stated");
  if (item.location) {
    add(fields, "dt", null, "Where");
    add(fields, "dd", null, item.location);
  }
  if (Array.isArray(item.attendees) && item.attendees.length) {
    add(fields, "dt", null, "Guests");
    add(fields, "dd", null, item.attendees.join(", "));
  }
  if (item.action === "update" && item.eventId) {
    add(fields, "dt", null, "Changes");
    add(fields, "dd", null, "an event already in that calendar");
  }
  add(fields, "dt", null, "Why");
  add(fields, "dd", null, item.why || sourceLabel(item));

  if (item.description) add(box, "div", "result__body", item.description);

  add(
    box,
    "p",
    "queue__warn",
    item.action === "update"
      ? "Approving CHANGES this event in your calendar, straight away. Discarding does nothing at all."
      : "Approving CREATES this event in your calendar, straight away. Discarding does nothing at all.",
  );

  const acts = add(box, "div", "queue__acts");
  const go = add(acts, "button", "cta--solid cta--act", item.action === "update" ? "Make the change" : "Create it");
  go.type = "button";
  go.disabled = queueBusy || !queueCanWrite;
  go.addEventListener("click", () => {
    const sure = window.confirm(
      `${item.action === "update" ? "Change this event?" : "Create this event?"}\n\n` +
        `${item.summary || "(no title)"}\n${spanLabel(item.from, item.to)}\n` +
        `In your ${item.account || "—"} calendar\n\n` +
        "This happens now, for real. It is not a note and it is not a draft.",
    );
    if (sure) sendDecision(item.id, "approve");
  });

  const drop = add(acts, "button", "ghost", "Discard");
  drop.type = "button";
  drop.disabled = queueBusy;
  drop.addEventListener("click", () => sendDecision(item.id, "discard"));

  add(
    acts,
    "span",
    "queue__hint",
    queueCanWrite
      ? "He asked. Only you can do it."
      : "This station has no calendar-write account wired, so approving would fail. Nothing is hidden from you; it just can't be done yet.",
  );
  return box;
}

function buildQueueCard(item) {
  if (item.type === "event") return buildProposalCard(item);

  const box = document.createElement("article");
  box.className = "result queue__card";

  const head = add(box, "div", "result__head");
  add(head, "span", "result__kind", "Draft");
  add(head, "span", "result__when", whenLabel(item.at));

  if (item.subject) add(box, "h3", "result__title", item.subject);

  const fields = add(box, "dl", "result__field");
  add(fields, "dt", null, "To");
  add(fields, "dd", null, item.to || "—");
  add(fields, "dt", null, "From");
  add(fields, "dd", null, item.account ? `your ${item.account} account` : "not stated");
  add(fields, "dt", null, "Why");
  add(fields, "dd", null, sourceLabel(item));

  if (item.body) {
    add(box, "div", "result__body", item.body);
  } else {
    // A routine's log line is a pointer, not the draft. Saying so beats showing an
    // empty box, and beats pretending the text is here.
    add(
      box,
      "p",
      "queue__pointer",
      "The text is in your Gmail drafts — this card is the note that it exists.",
    );
  }

  const acts = add(box, "div", "queue__acts");
  const keep = add(acts, "button", "cta--solid", "Approve");
  keep.type = "button";
  keep.disabled = queueBusy;
  keep.addEventListener("click", () => sendDecision(item.id, "approve"));

  const drop = add(acts, "button", "ghost", "Discard");
  drop.type = "button";
  drop.disabled = queueBusy;
  drop.addEventListener("click", () => {
    const sure = window.confirm(
      `Discard this draft?\n\n${item.subject || "(no subject)"}\nTo ${item.to || "—"}\n\n` +
        "This takes it off the queue. It does not delete anything in Gmail — the draft stays " +
        "there until you delete it yourself.",
    );
    if (sure) sendDecision(item.id, "discard");
  });

  add(acts, "span", "queue__hint", "Approving marks it read. You send it from Gmail.");
  return box;
}

// What happened to the things already decided. Only entries that produced a
// real result are shown — an approved draft produced nothing, deliberately, and
// there is no outcome to report for it. An event carries its id and, when
// Google gave one, a link to go and look at what was actually made.
function drawQueueRecent(recent) {
  if (!queueRecent) return;
  queueRecent.textContent = "";
  const done = (Array.isArray(recent) ? recent : []).filter((r) => r?.result?.eventId);
  for (const row of done.slice(0, 4)) {
    const li = add(queueRecent, "li", "queue__recent-row");
    add(
      li,
      "span",
      "queue__recent-what",
      `${row.result.action === "update" ? "Changed" : "Created"} “${row.subject || "(untitled)"}” in your ${row.result.account} calendar`,
    );
    // Same rule as every other link on this page: parsed first, http(s) only,
    // label is a text node, and it leaves with the full set of rel tokens.
    const href = safeHref(row.result.link);
    if (href) {
      const anchor = document.createElement("a");
      anchor.className = "turn__link";
      anchor.href = href;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer nofollow";
      anchor.textContent = "open it";
      li.appendChild(anchor);
    }
  }
}

function drawQueue(payload) {
  if (!queueStack) return;
  queueStack.textContent = "";

  if (payload?.state === "error") {
    queueNote.textContent = payload.error || "The queue couldn't be read on the station.";
    queueWhen.textContent = "couldn't read";
    return;
  }

  queueCanWrite = payload?.calendarWrite !== false;
  const pending = Array.isArray(payload?.pending) ? payload.pending : [];
  for (const item of pending) queueStack.appendChild(buildQueueCard(item));
  drawQueueRecent(payload?.recent);

  const counts = payload?.counts || {};
  const decided = (counts.approved || 0) + (counts.discarded || 0);
  if (pending.length) {
    queueNote.textContent = QUEUE_NOTE;
    queueWhen.textContent = counts.events
      ? `${pending.length} waiting · ${counts.events} would change your calendar`
      : `${pending.length} waiting`;
  } else {
    queueNote.textContent = decided
      ? "Nothing waiting. New drafts land here as he writes them — from a routine, or from something you asked for."
      : "Nothing waiting. When he drafts a reply it will appear here before it goes anywhere, and it goes nowhere without you.";
    queueWhen.textContent = decided
      ? `${counts.approved || 0} approved, ${counts.discarded || 0} discarded`
      : "empty";
  }
}

async function checkQueue() {
  if (!queueStack) return;
  try {
    const res = await fetch("/api/queue", { cache: "no-store" });
    drawQueue(await res.json());
  } catch {
    queueWhen.textContent = "couldn't read";
    queueNote.textContent = "Couldn't reach the station to read the queue.";
  }
}

async function sendDecision(id, decision) {
  if (queueBusy) return;
  queueBusy = true;
  // An event approval is a container start plus a round trip to Google, so it
  // is visibly slower than a draft's bookkeeping. Saying which is happening
  // beats a button that looks stuck.
  const isEvent = id.startsWith("e-") || id.startsWith("v-");
  queueWhen.textContent =
    decision === "discard" ? "discarding…" : isEvent ? "putting it in your calendar…" : "approving…";
  try {
    const res = await fetch("/api/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, decision }),
    });
    const body = await res.json();
    if (!res.ok) {
      queueNote.textContent = body?.error || `The station answered ${res.status}.`;
      queueBusy = false;
      await checkQueue();
      return;
    }
    queueBusy = false;
    drawQueue(body.queue);
    if (body?.result?.eventId) {
      queueNote.textContent =
        body.result.action === "update"
          ? `Done — that event has been changed in your ${body.result.account} calendar.`
          : `Done — that event is now in your ${body.result.account} calendar.`;
    }
  } catch {
    queueBusy = false;
    queueNote.textContent = "Couldn't reach the station to record that.";
  }
}

if (queueStack) {
  checkQueue();
  setInterval(checkQueue, 45000);
}

loadStore();
setDesk("coordinator");
drawReading();
drawArchive();
updateComposer();

// --- start ---------------------------------------------------------------
// Last, deliberately: the first status render touches the chat's composer, so
// the chat's own bindings have to exist before anything polls.

poll();
setInterval(poll, 15000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") poll();
});
