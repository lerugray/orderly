import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyTheme,
  DEFAULT_THEME,
  getTheme,
  initTheme,
  setTheme,
  THEMES,
  THEME_STORAGE_KEY,
} from "../public/themes.js";
import { publicAssetPath, themeMascotPath } from "../server.mjs";

const TEST_DIR = resolve(fileURLToPath(import.meta.url), "..");
const WEB = resolve(TEST_DIR, "..");
const REPO = resolve(WEB, "..");

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

class MemoryStorage {
  constructor(entries = []) {
    this.values = new Map(entries);
  }
  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }
  setItem(key, value) {
    this.values.set(key, String(value));
  }
  removeItem(key) {
    this.values.delete(key);
  }
}

class FakeStyle {
  constructor() {
    this.values = new Map();
  }
  setProperty(name, value) {
    this.values.set(name, value);
  }
  removeProperty(name) {
    this.values.delete(name);
  }
}

// These fixtures model the DOM's own split, because that split is what shipped
// the bug: `hidden` is an HTMLElement IDL attribute reflecting a content
// attribute, and an inline <svg> is an SVGElement that answers to no such
// property. A fixture where every element takes a plain `.hidden` field cannot
// tell a working theme swap from a broken one.
class FakeElement {
  constructor(attributes = {}) {
    this.attributes = new Map(Object.entries(attributes));
    this.style = new FakeStyle();
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  toggleAttribute(name, force) {
    const on = force === undefined ? !this.attributes.has(name) : Boolean(force);
    if (on) this.attributes.set(name, "");
    else this.attributes.delete(name);
    return on;
  }
}

// An inline <svg>. Element methods only: no `hidden` accessor, so a regression
// to `element.hidden = true` sets a stray field the stylesheet never sees.
class FakeSvgElement extends FakeElement {}

// An HTML element, where `hidden` reflects the content attribute both ways.
class FakeHtmlElement extends FakeElement {
  get hidden() {
    return this.hasAttribute("hidden");
  }
  set hidden(value) {
    this.toggleAttribute("hidden", value);
  }
}

function documentFixture() {
  const root = new FakeHtmlElement();
  const header = new FakeHtmlElement({ src: "/mark.svg", "data-default-src": "/mark.svg" });
  const icon = new FakeHtmlElement({ href: "/favicon.svg", "data-default-href": "/favicon.svg" });
  // The hero figure as index.html ships it: two inline <svg> mascots, the
  // default one drawn in the page and the themed slot the desk draws into.
  // Neither answers to a `.hidden` property, and neither takes a `src`.
  const original = new FakeSvgElement();
  const alternate = new FakeSvgElement({ hidden: "" });
  const meta = new FakeHtmlElement({ content: "#161E2E", "data-default-content": "#161E2E" });
  const bySelector = new Map([
    ["[data-theme-mascot]", [header]],
    ["[data-theme-icon]", [icon]],
    ["[data-default-mascot]", [original]],
    ["[data-themed-mascot]", [alternate]],
    ["meta[data-theme-color]", [meta]],
  ]);
  return {
    document: { documentElement: root, querySelectorAll: (selector) => bySelector.get(selector) || [] },
    root,
    header,
    icon,
    original,
    alternate,
    meta,
  };
}

test("the identity manifest has six named palette-and-mascot pairings", async () => {
  assert.equal(THEMES.length, 6);
  assert.equal(THEMES[0].id, DEFAULT_THEME);
  assert.equal(THEMES[0].candidate, "cand-1-navycap");
  assert.deepEqual(THEMES.map((theme) => theme.candidate), [
    "cand-1-navycap", "cand-2", "cand-3", "cand-4", "cand-5", "cand-6",
  ]);
  for (const theme of THEMES) {
    assert.equal(theme.swatches.length, 4);
    if (theme.id === DEFAULT_THEME) continue;
    const source = resolve(REPO, "assets", "logo-candidates", "variants", `${theme.id}.svg`);
    const shipped = resolve(WEB, "public", "theme-mascots", `${theme.id}.svg`);
    const sourceSvg = await readFile(source, "utf8");
    assert.match(sourceSvg, /^<svg[^>]+viewBox="0 0 32 32">/);
    assert.equal(await readFile(shipped, "utf8"), sourceSvg);
  }
});

test("no saved theme preserves the original untagged desk byte-for-byte defaults", () => {
  const storage = new MemoryStorage();
  const page = documentFixture();
  assert.equal(getTheme(storage), DEFAULT_THEME);
  assert.equal(initTheme(storage, page.document), DEFAULT_THEME);
  assert.equal(page.root.getAttribute("data-theme"), null);
  assert.equal(page.root.style.values.size, 0);
  assert.equal(page.header.getAttribute("src"), "/mark.svg");
  assert.equal(page.icon.getAttribute("href"), "/favicon.svg");
  assert.equal(page.original.hasAttribute("hidden"), false);
  assert.equal(page.alternate.hasAttribute("hidden"), true);
  assert.equal(page.meta.getAttribute("content"), "#161E2E");
  assert.equal(storage.getItem(THEME_STORAGE_KEY), null);
});

test("a theme can be set, read, and applied again from persisted storage", () => {
  const storage = new MemoryStorage();
  const firstPage = documentFixture();
  assert.deepEqual(setTheme("tidepool", storage, firstPage.document), {
    theme: "tidepool",
    persisted: true,
  });
  assert.equal(getTheme(storage), "tidepool");
  assert.equal(firstPage.root.getAttribute("data-theme"), "tidepool");
  assert.equal(firstPage.root.style.values.get("--coral"), "#3cc7b7");
  assert.equal(firstPage.header.getAttribute("src"), "/theme-mascots/tidepool.svg");
  assert.equal(firstPage.icon.getAttribute("href"), "/theme-mascots/tidepool.svg");
  assert.equal(firstPage.original.hasAttribute("hidden"), true);
  assert.equal(firstPage.alternate.hasAttribute("hidden"), false);

  const reloadedPage = documentFixture();
  assert.equal(initTheme(storage, reloadedPage.document), "tidepool");
  assert.equal(reloadedPage.root.getAttribute("data-theme"), "tidepool");
  assert.equal(reloadedPage.alternate.getAttribute("data-mascot-src"), "/theme-mascots/tidepool.svg");
});

test("selecting Night Desk clears persistence and removes every alternate override", () => {
  const storage = new MemoryStorage([[THEME_STORAGE_KEY, "blue-hour"]]);
  const page = documentFixture();
  applyTheme("blue-hour", page.document);
  assert.equal(page.root.style.values.size > 0, true);
  setTheme(DEFAULT_THEME, storage, page.document);
  assert.equal(storage.getItem(THEME_STORAGE_KEY), null);
  assert.equal(page.root.getAttribute("data-theme"), null);
  assert.equal(page.root.style.values.size, 0);
  assert.equal(page.header.getAttribute("src"), "/mark.svg");
  assert.equal(page.icon.getAttribute("href"), "/favicon.svg");
  assert.equal(page.original.hasAttribute("hidden"), false);
  assert.equal(page.alternate.hasAttribute("hidden"), true);
});

test("every variant puts its own mascot in the hero and takes the default one down", () => {
  const defaultMascot = THEMES[0].mascot;
  for (const theme of THEMES.slice(1)) {
    const page = documentFixture();
    applyTheme(theme.id, page.document);

    // The default mascot must leave the layout, not merely take the palette.
    assert.equal(
      page.original.hasAttribute("hidden"),
      true,
      `${theme.id} left the default mascot painted`,
    );
    assert.equal(page.alternate.hasAttribute("hidden"), false, `${theme.id} hid its own mascot`);
    assert.equal(
      page.alternate.getAttribute("data-mascot-src"),
      theme.mascot,
      `${theme.id} named the wrong asset for the hero`,
    );
    assert.notEqual(theme.mascot, defaultMascot, `${theme.id} points at the default asset`);
    assert.equal(page.header.getAttribute("src"), theme.mascot);
    assert.equal(page.icon.getAttribute("href"), theme.mascot);
  }

  // And the default is the exact inverse: its own artwork, no alternate beside it.
  const home = documentFixture();
  applyTheme(DEFAULT_THEME, home.document);
  assert.equal(home.original.hasAttribute("hidden"), false);
  assert.equal(home.alternate.hasAttribute("hidden"), true);
  assert.equal(home.header.getAttribute("src"), defaultMascot);
  // Back on the default, nothing names a variant file for the hero to draw.
  assert.equal(home.alternate.hasAttribute("data-mascot-src"), false);
});

test("the shipped hero figure is the pair of inline svg mascots these fixtures model", async () => {
  const html = await readFile(resolve(WEB, "public", "index.html"), "utf8");
  const figure = /<div class="duty__figure">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(figure, "index.html must ship the hero figure");
  // Both mascots being SVGElements is the whole reason `.hidden` fails on them.
  // If this markup ever changes, the fixture split above must be rechecked.
  assert.match(figure[1], /<svg\b[^>]*\bdata-default-mascot\b/);
  assert.match(figure[1], /<svg\b[^>]*\bdata-themed-mascot\b/);
  assert.doesNotMatch(figure[1], /<img\b[^>]*\bdata-default-mascot\b/);
  // An <img> seals the artwork away from the page, which is exactly what left
  // every chosen variant sitting still while the default one blinked.
  assert.doesNotMatch(figure[1], /<img\b[^>]*\bdata-themed-mascot\b/);
});

test("the stylesheet hides on the attribute hard enough to beat the mascot layout rule", async () => {
  const css = await readFile(resolve(WEB, "public", "orderly.css"), "utf8");
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  // The rule it has to beat: the themed mascot carries a display of its own.
  assert.match(css, /\.mascot--themed\s*\{[^}]*display:\s*block/);
});

test("no variant mascot is the default one recoloured: each ships its own shape", async () => {
  const shapeOf = (svg) => [...svg.matchAll(/<([a-z]+)\b/g)].map((match) => match[1]).join(" ");
  const base = shapeOf(await readFile(resolve(WEB, "public", "mark.svg"), "utf8"));
  for (const theme of THEMES.slice(1)) {
    const art = await readFile(resolve(WEB, "public", "theme-mascots", `${theme.id}.svg`), "utf8");
    assert.notEqual(shapeOf(art), base, `${theme.id} is the default mascot with new colours`);
  }
});

// The liveliness contract: the four things orderly.js reaches for once a mascot
// is on screen. A variant that ships without them renders as a still picture
// beside a default mark that blinks and follows the pointer — which is exactly
// the gap the picker fix exposed.
test("every variant ships the moving parts the desk binds, not just artwork", async () => {
  for (const theme of THEMES.slice(1)) {
    const art = await readFile(resolve(WEB, "public", "theme-mascots", `${theme.id}.svg`), "utf8");
    const where = `${theme.id}.svg`;

    // A pupil group to translate, and a lid to drop by its own eye's travel.
    assert.match(art, /<g class="m-pupil">/, `${where} has no pupil group to move`);
    const lid = /<rect class="m-lid"[^>]*>/.exec(art);
    assert.ok(lid, `${where} has no lid to blink`);
    const travel = /data-lid-close="([\d.]+)"/.exec(lid[0]);
    assert.ok(travel, `${where} does not say how far its lid must travel to shut`);
    assert.ok(Number(travel[1]) > 0, `${where} declares a lid that never closes`);
    // The lid must be painted, or it is a black bar over the eye in any surface
    // that renders this file without the desk's stylesheet.
    assert.match(lid[0], /\sfill="#[0-9A-Fa-f]{6}"/, `${where} ships an unpainted lid`);

    // Both mouth shapes travel with the art: the default mark's own geometry
    // does not fit a face drawn somewhere else.
    const mouth = /<path class="m-mouth"[^>]*>/.exec(art);
    assert.ok(mouth, `${where} has no mouth to set`);
    const smile = /data-mouth-smile="([^"]+)"/.exec(mouth[0]);
    const flat = /data-mouth-flat="([^"]+)"/.exec(mouth[0]);
    assert.ok(smile && flat, `${where} carries only one mouth`);
    assert.notEqual(smile[1], flat[1], `${where} smiles and frowns identically`);
    assert.match(mouth[0], new RegExp(`\\sd="${smile[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
      `${where} rests on a mouth that is not its own smile`);

    // The lid is clipped to that variant's eye, under an id that cannot collide
    // with the default mark's or another variant's once both are in one page.
    assert.match(art, new RegExp(`<clipPath id="eyeClip-${theme.id}">`), `${where} has no eye clip of its own`);
    assert.match(art, new RegExp(`clip-path="url\\(#eyeClip-${theme.id}\\)"`), `${where} never uses its eye clip`);
    assert.doesNotMatch(art, /id="eyeClip"/, `${where} would collide with the default mark's clip`);
  }
});

test("the stylesheet shares the eye's motion but keeps the default mark's paint to itself", async () => {
  const css = await readFile(resolve(WEB, "public", "orderly.css"), "utf8");
  // Movement is every mascot's.
  assert.match(css, /\.m-lid\s*\{[^}]*transition:\s*transform/);
  assert.match(css, /\.m-pupil\s*\{[^}]*transition:\s*transform/);
  // Paint is the default's alone: a variant arrives already coloured, and a
  // palette rule reaching it would repaint art that is already right.
  for (const rule of [/\.m-pupil circle/, /\.m-mouth/, /\.m-lid/]) {
    const painted = new RegExp(`(^|\\n)\\s*${rule.source}\\s*\\{[^}]*(fill|stroke):`, "m");
    const match = painted.exec(css);
    if (!match) continue;
    assert.fail(`an unscoped ${rule.source} rule paints every mascot: ${match[0].trim()}`);
  }
  assert.match(css, /\.mascot--default \.m-pupil circle\s*\{[^}]*fill:\s*var\(--ink\)/);
  assert.match(css, /\.mascot--default \.m-lid\s*\{[^}]*fill:\s*var\(--coral\)/);
  // And the duty treatment stays on every mascot, whichever one is showing.
  assert.match(css, /\.duty\[data-state="off"\] \.mascot\s*\{[^}]*filter:/);
  assert.match(css, /\.duty\[data-state="off"\] \.m-lid\s*\{[^}]*transform:/);
});

test("the desk binds the mascot that is showing, not the first one in the page", async () => {
  const source = await readFile(resolve(WEB, "public", "orderly.js"), "utf8");
  // The original bug in one line: a module-scope querySelector(".mascot") binds
  // the default mark for the life of the page, whichever theme is chosen.
  assert.doesNotMatch(source, /^const (mascot|pupil|lid|mouth) = document\.querySelector/m);
  assert.match(source, /function visibleMascot\(\)/);
  assert.match(source, /!one\.hasAttribute\("hidden"\)/);
  assert.match(source, /bindMascot\(visibleMascot\(\)\)/);
  // The themed slot is filled from the manifest's own files and from nothing
  // else, and the artwork is refused if it carries anything executable.
  assert.match(source, /MASCOT_FILES\.has\(source\)/);
  assert.match(source, /script, foreignObject/);
  assert.match(source, /startsWith\("on"\)/);
});

test("unknown saved names fall back without mutation and unknown sets are refused", () => {
  const storage = new MemoryStorage([[THEME_STORAGE_KEY, "not-a-theme"]]);
  assert.equal(getTheme(storage), DEFAULT_THEME);
  assert.equal(storage.getItem(THEME_STORAGE_KEY), "not-a-theme");
  assert.throws(() => setTheme("not-a-theme", storage, documentFixture().document), TypeError);
});

test("every manifest and settings route resolves inside the shipped web tree", () => {
  for (const theme of THEMES) {
    const asset = theme.id === DEFAULT_THEME
      ? publicAssetPath(theme.mascot)
      : themeMascotPath(theme.mascot);
    assert.ok(asset, `${theme.mascot} must resolve`);
    assert.equal(isWithin(WEB, asset), true, `${theme.mascot} escaped web/`);
  }
  const settings = publicAssetPath("/settings.html");
  assert.equal(settings, resolve(WEB, "public", "settings.html"));
  assert.equal(isWithin(WEB, settings), true, "/settings escaped web/");
});

test("the server exposes only the five shipped allowlisted variant asset routes", () => {
  for (const theme of THEMES.slice(1)) {
    assert.equal(
      themeMascotPath(theme.mascot),
      resolve(WEB, "public", "theme-mascots", `${theme.id}.svg`),
    );
  }
  assert.equal(themeMascotPath("/theme-mascots/../cand-1.svg"), null);
  assert.equal(themeMascotPath("/theme-mascots/not-a-theme.svg"), null);
});

test("top-level web modules cannot derive a parent-of-web path from HERE", async () => {
  const modules = (await readdir(WEB)).filter((name) => name.endsWith(".mjs"));
  const escape = /resolve\s*\(\s*HERE\s*,\s*["']\.\.["']/;
  for (const module of modules) {
    assert.doesNotMatch(await readFile(resolve(WEB, module), "utf8"), escape, module);
  }
});
