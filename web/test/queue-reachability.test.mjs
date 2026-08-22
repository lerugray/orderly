// Every item counted as waiting can be reached through the supported path.
//
// The queue bounds what one response carries. That bound is deliberate and is
// not what this checks. What it checks is that the bound hides nothing: an
// operator following the queue's own paging must arrive at every card the count
// claims is waiting, exactly once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { observeDraft, readQueue, decide } from "../queue.mjs";

async function bench(prefix, count) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const pendingPath = join(dir, "PENDING.md");
  const statePath = join(dir, "state.json");
  await writeFile(pendingPath, "# PENDING\n");
  await writeFile(statePath, JSON.stringify({ v: 2, observed: [], decisions: {}, results: {} }));
  const ids = [];
  for (let i = 1; i <= count; i += 1) {
    ids.push(await observeDraft({
      statePath,
      card: { subject: `Note ${i}`, to: `p${i}@example.com`, account: "personal" },
      desk: "coordinator",
    }));
  }
  return { pendingPath, statePath, ids };
}

// Follow the queue's own paging to the end, recording how often each card was
// offered. A card seen twice is as wrong as a card never seen.
async function walk({ pendingPath, statePath }, interleave) {
  const offered = new Map();
  const pages = [];
  let cursor = null;
  for (let guard = 0; guard < 40; guard += 1) {
    const queue = await readQueue({ pendingPath, statePath, after: cursor });
    pages.push(queue.pending.length);
    for (const item of queue.pending) offered.set(item.id, (offered.get(item.id) ?? 0) + 1);
    if (interleave) await interleave(queue, pages.length);
    const next = queue.nextCursor ?? null;
    if (!next || next === cursor) return { offered, pages, counted: queue.counts.pending };
    cursor = next;
  }
  throw new Error("paging did not terminate");
}

test("every item counted as waiting can be reached by paging", async () => {
  const paths = await bench("orderly-reach-all-", 150);
  const { offered, counted } = await walk(paths);
  const seenOnce = [...offered.values()].filter((n) => n === 1).length;
  assert.deepEqual(
    { reached: offered.size, seenExactlyOnce: seenOnce },
    { reached: counted, seenExactlyOnce: counted },
    `the queue counts ${counted} cards as waiting, but following its own paging to the end `
      + `reached ${offered.size} of them, ${seenOnce} exactly once. A card the count claims is `
      + `waiting and the paging never offers cannot be answered by an operator.`
      + ` Every counted card must be reachable exactly once.`,
  );
});

test("paging is exact at and around the page boundary", async () => {
  const wrong = [];
  for (const n of [120, 121, 239, 240, 241]) {
    const paths = await bench(`orderly-reach-${n}-`, n);
    const { offered, counted } = await walk(paths);
    const repeated = [...offered.values()].filter((c) => c > 1).length;
    if (offered.size !== counted || repeated) {
      wrong.push(`${n}: counted ${counted}, reached ${offered.size}, ${repeated} repeated`);
    }
  }
  assert.deepEqual(wrong, [], `paging loses or repeats cards at a page edge: ${wrong.join("; ")}.`
    + ` Every counted card must be reachable exactly once.`);
});

test("a decision taken between pages neither repeats nor skips a card", async () => {
  const paths = await bench("orderly-reach-shift-", 150);
  const answered = [];
  // Answer a card from the first page before asking for the second. The set
  // shifts underneath the reader, which is exactly when offset paging slips.
  const { offered } = await walk(paths, async (queue, pageNumber) => {
    if (pageNumber === 1) {
      // Answer the card the cursor names. Any card would shift the set, but this
      // is the one whose absence a position-based reader cannot survive: it has
      // to resume from a card that is no longer there.
      const victim = queue.pending[queue.pending.length - 1];
      await decide({ ...paths, id: victim.id, decision: "approve" });
      answered.push(victim.id);
    }
  });
  const repeated = [...offered.entries()].filter(([, c]) => c > 1).map(([id]) => id);
  const missing = paths.ids.filter((id) => !offered.has(id) && !answered.includes(id));
  assert.deepEqual(
    { repeated, missing },
    { repeated: [], missing: [] },
    `a card was answered between page one and page two, and paging then repeated `
      + `${repeated.length} card(s) and skipped ${missing.length}.`
      + ` Every counted card must be reachable exactly once.`,
  );
});

test("a card first seen on a later page can be answered", async () => {
  const paths = await bench("orderly-reach-act-", 150);
  const first = await readQueue({ ...paths });
  const firstPage = new Set(first.pending.map((item) => item.id));
  const later = await readQueue({ ...paths, after: first.nextCursor ?? null });
  const beyond = later.pending.find((item) => !firstPage.has(item.id));
  assert.ok(beyond, "paging offered no card that the first page did not already show");
  const outcome = await decide({ ...paths, id: beyond.id, decision: "approve" })
    .then(() => "answered", (error) => `refused: ${error.message}`);
  const after = await readQueue({ ...paths });
  assert.deepEqual(
    { outcome, counted: after.counts.pending },
    { outcome: "answered", counted: first.counts.pending - 1 },
    `a card reached only by paging was answered with "${outcome}", and the waiting count `
      + `went from ${first.counts.pending} to ${after.counts.pending}.`
      + ` Every counted card must be reachable exactly once.`,
  );
});


// The operator's path runs through the browser as well as the module, so the
// second half of this file drives the shipped view rather than inspecting it.

function makeEl(tag = "div") {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [], parentNode: null, listeners: {},
    className: "", id: "", type: "", href: "", title: "", disabled: false,
    dataset: {}, style: {}, _text: "", _attrs: {},
    classList: {
      add(...c) { node.className = [...new Set([...node.className.split(" ").filter(Boolean), ...c])].join(" "); },
      remove(...c) { node.className = node.className.split(" ").filter((x) => x && !c.includes(x)).join(" "); },
      toggle() {}, contains(c) { return node.className.split(" ").includes(c); },
    },
    appendChild(child) { node.children.push(child); child.parentNode = node; return child; },
    append(...kids) { for (const k of kids) node.appendChild(typeof k === "string" ? textNode(k) : k); },
    insertBefore(child) { return node.appendChild(child); },
    remove() { const p = node.parentNode; if (p) p.children = p.children.filter((c) => c !== node); },
    setAttribute(k, v) { node._attrs[k] = String(v); if (k in node) node[k] = v; },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(node._attrs, k) ? node._attrs[k] : null; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(node._attrs, k); },
    removeAttribute(k) { delete node._attrs[k]; },
    closest() { return null; }, matches(sel) { return matches(node, sel); },
    replaceChildren(...kids) { node.children = []; node._text = ""; for (const k of kids) node.appendChild(k); },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }; },
    focus() {}, blur() {}, scrollIntoView() {},
    addEventListener(ev, fn) { (node.listeners[ev] ||= []).push(fn); },
    removeEventListener() {},
    click() { for (const fn of node.listeners.click || []) fn({ preventDefault() {}, stopPropagation() {} }); },
    querySelector(sel) { return descend(node, sel)[0] ?? null; },
    querySelectorAll(sel) { return descend(node, sel); },
    get firstChild() { return node.children[0] ?? null; },
    get lastChild() { return node.children[node.children.length - 1] ?? null; },
    get textContent() { return node._text || node.children.map((c) => c.textContent).join(""); },
    set textContent(v) { node._text = String(v); node.children = []; },
    get innerHTML() { return ""; },
    set innerHTML(v) { node._text = String(v); node.children = []; },
  };
  return node;
}
const textNode = (t) => { const n = makeEl("#text"); n._text = t; return n; };

function matches(node, sel) {
  if (sel.startsWith(".")) return node.className.split(" ").includes(sel.slice(1));
  if (sel.startsWith("#")) return node.id === sel.slice(1);
  return node.tagName === sel.toUpperCase();
}
function descend(root, sel) {
  const out = [];
  for (const child of root.children) {
    if (matches(child, sel)) out.push(child);
    out.push(...descend(child, sel));
  }
  return out;
}

// Load the real orderly.js and hand back the bindings the queue view lives in.
async function loadQueueView(sourcePath, { fetchImpl }) {
  const ids = ["queue-stack", "queue-note", "queue-when"];
  const registry = new Map(ids.map((id) => { const e = makeEl("div"); e.id = id; return [id, e]; }));
  const document = {
    getElementById: (id) => registry.get(id) ?? (registry.set(id, makeEl("div")), registry.get(id)),
    querySelector: () => makeEl("div"),
    querySelectorAll: () => [],
    createElement: (tag) => makeEl(tag),
    createTextNode: textNode,
    addEventListener() {}, removeEventListener() {},
    body: makeEl("body"), documentElement: makeEl("html"),
    readyState: "complete",
  };
  const noop = () => 0;
  const sandbox = {
    document, console,
    window: { addEventListener() {}, removeEventListener() {}, location: { href: "http://station/", pathname: "/" },
              matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
              setTimeout: noop, clearTimeout: noop },
    location: { href: "http://station/", pathname: "/", reload() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
    setInterval: noop, clearInterval: noop, setTimeout: noop, clearTimeout: noop,
    requestAnimationFrame: noop, cancelAnimationFrame: noop,
    fetch: (...a) => fetchImpl(...a),
    URL, URLSearchParams, JSON, Math, Date, Object, Array, String, Number, Boolean,
    Promise, Set, Map, Error, encodeURIComponent, decodeURIComponent, isNaN, parseInt, parseFloat,
  };
  sandbox.globalThis = sandbox;
  sandbox.window.document = document;
  // orderly.js is an ES module. Its bindings are resolved from the real files it
  // names, not stubbed, and the import lines are then blanked so the rest can run
  // in one script scope with its line numbers intact. If the file ever imports
  // something this does not know how to resolve, that is a failure here rather
  // than a test that quietly runs a different program.
  let source = await readFile(sourcePath, "utf8");
  const imports = [...source.matchAll(/^import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'];?\s*$/gm)];
  const plain = [...source.matchAll(/^import\s+["'][^"']+["'];?\s*$/gm)];
  const known = new Set(["./themes.js"]);
  const unknown = imports.map((m) => m[2]).filter((spec) => !known.has(spec));
  assert.deepEqual(
    { unknown, sideEffectImports: plain.length },
    { unknown: [], sideEffectImports: 0 },
    "the view imports something this harness cannot resolve, so it would be running a different program than the one shipped",
  );
  for (const match of imports) {
    const module = await import(new URL(match[2], `file://${sourcePath}`).href);
    for (const raw of match[1].split(",")) {
      const name = raw.trim().split(/\s+as\s+/).pop().trim();
      const from = raw.trim().split(/\s+as\s+/)[0].trim();
      if (name) sandbox[name] = module[from];
    }
    source = source.replace(match[0], "");
  }
  vm.createContext(sandbox);
  // The script is one lexical scope, so this hands back its own bindings.
  // Bind only what this revision actually defines. Naming a function the code
  // does not have would fail the load itself, and every assertion after it would
  // then be reporting a missing binding rather than what the view does.
  vm.runInContext(
    `${source}\n;globalThis.__view = {\n`
    + `  drawQueue: typeof drawQueue === "function" ? drawQueue : null,\n`
    + `  checkQueue: typeof checkQueue === "function" ? checkQueue : null,\n`
    + `  loadMoreQueue: typeof loadMoreQueue === "function" ? loadMoreQueue : null,\n`
    + `};`,
    sandbox, { filename: "orderly.js" });
  return {
    ...sandbox.__view,
    stack: registry.get("queue-stack"),
    when: registry.get("queue-when"),
    note: registry.get("queue-note"),
  };
}

const ORDERLY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public", "orderly.js");
const card = (i) => ({ id: `w-${i}`, type: "draft", subject: `Note ${i}`, to: `p${i}@example.com`,
  account: "personal", at: "2026-08-01T09:00:00.000Z", body: `body ${i}` });

// A station with 150 waiting, served 120 at a time.
function station(total, pageSize) {
  const all = Array.from({ length: total }, (_, i) => card(i + 1));
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const after = new URL(String(url), "http://station").searchParams.get("after");
    const start = after ? all.findIndex((c) => c.id === after) + 1 : 0;
    const slice = all.slice(start, start + pageSize);
    const last = slice[slice.length - 1];
    const more = start + slice.length < all.length;
    return { json: async () => ({
      state: "ok", calendarWrite: true, pending: slice, recent: [],
      nextCursor: more && last ? last.id : null,
      counts: { pending: all.length, events: 0, approved: 0, discarded: 0 },
    }) };
  };
  return { all, calls, fetchImpl };
}

test("the queue reports the backlog, not the size of one response", async () => {
  const { calls, fetchImpl } = station(150, 120);
  const view = await loadQueueView(ORDERLY, { fetchImpl });
  await view.checkQueue();
  assert.equal(
    view.when.textContent, "150 waiting · 120 shown",
    `the queue was given a count of 150 and a response carrying 120, and told the operator `
      + `"${view.when.textContent}".`,
  );
  // Nothing is paged eagerly: the bound is respected until the operator asks.
  const paged = calls.filter((u) => u.includes("after="));
  assert.deepEqual(paged, [], "the first render fetched further pages without being asked");
});

test("the rest of the backlog can be brought on screen and then it is all shown", async () => {
  const { calls, fetchImpl } = station(150, 120);
  const view = await loadQueueView(ORDERLY, { fetchImpl });
  await view.checkQueue();

  const more = view.stack.querySelector(".queue-more");
  assert.ok(more, "no control was offered for the 30 cards that were counted but not shown");
  const button = more.querySelector("BUTTON");
  assert.equal(button.textContent, "Load 30 more",
    `the control read "${button.textContent}"`);

  button.click();
  await new Promise((r) => setImmediate(r));

  const asked = calls.filter((u) => u.startsWith("/api/queue")).pop();
  assert.match(asked, /\/api\/queue\?after=/, `the second request was "${asked}"`);
  assert.equal(view.when.textContent, "150 waiting",
    `after loading the rest the queue said "${view.when.textContent}"`);
  assert.equal(view.stack.querySelector(".queue-more"), null,
    "the control is still offered when there is nothing left to load");
});

test("a backlog that fits in one response says so plainly and offers nothing more", async () => {
  const { fetchImpl } = station(12, 120);
  const view = await loadQueueView(ORDERLY, { fetchImpl });
  await view.checkQueue();
  assert.equal(view.when.textContent, "12 waiting");
  assert.equal(view.stack.querySelector(".queue-more"), null);
});
