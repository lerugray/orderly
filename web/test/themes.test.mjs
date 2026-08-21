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

class FakeElement {
  constructor(attributes = {}) {
    this.attributes = new Map(Object.entries(attributes));
    this.style = new FakeStyle();
    this.hidden = false;
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
}

function documentFixture() {
  const root = new FakeElement();
  const header = new FakeElement({ src: "/mark.svg", "data-default-src": "/mark.svg" });
  const icon = new FakeElement({ href: "/favicon.svg", "data-default-href": "/favicon.svg" });
  const original = new FakeElement();
  const alternate = new FakeElement({ src: "/mark.svg" });
  alternate.hidden = true;
  const meta = new FakeElement({ content: "#161E2E", "data-default-content": "#161E2E" });
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
  assert.equal(page.original.hidden, false);
  assert.equal(page.alternate.hidden, true);
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
  assert.equal(firstPage.original.hidden, true);
  assert.equal(firstPage.alternate.hidden, false);

  const reloadedPage = documentFixture();
  assert.equal(initTheme(storage, reloadedPage.document), "tidepool");
  assert.equal(reloadedPage.root.getAttribute("data-theme"), "tidepool");
  assert.equal(reloadedPage.alternate.getAttribute("src"), "/theme-mascots/tidepool.svg");
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
  assert.equal(page.original.hidden, false);
  assert.equal(page.alternate.hidden, true);
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
