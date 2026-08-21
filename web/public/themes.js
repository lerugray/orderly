// ORDERLY visual identities. This is the one manifest that binds a named
// palette to its mascot. The default is deliberately represented by an empty
// CSS override: with no saved choice the desk keeps its original root values,
// root attributes, and /mark.svg asset.

export const THEME_STORAGE_KEY = "orderly.theme.v1";
export const DEFAULT_THEME = "night-desk";

export const THEMES = Object.freeze([
  Object.freeze({
    id: DEFAULT_THEME,
    name: "Night Desk",
    note: "The original coral-and-navy station.",
    candidate: "cand-1-navycap",
    mascot: "/mark.svg",
    swatches: Object.freeze(["#161E2E", "#1E293D", "#F47B5A", "#F4EDE6"]),
    themeColor: "#161E2E",
    css: Object.freeze({}),
  }),
  Object.freeze({
    id: "tidepool",
    name: "Tidepool",
    note: "Deep teal, sea glass, and a crisp aqua signal.",
    candidate: "cand-2",
    mascot: "/theme-mascots/tidepool.svg",
    swatches: Object.freeze(["#10282D", "#193A40", "#3CC7B7", "#E8F5F1"]),
    themeColor: "#10282D",
    css: Object.freeze({
      "--ground": "#10282d", "--ground-deep": "#0a1d21", "--surface": "#193a40",
      "--surface-lift": "#234b51", "--line": "#2c6267", "--coral": "#3cc7b7",
      "--coral-dim": "#2d9f94", "--blush": "#f07872", "--ink": "#102c31",
      "--cream": "#e8f5f1", "--muted": "#9abfba", "--muted-deep": "#6e9995",
      "--ground-glow": "#1b454b", "--surface-shade": "#143136",
      "--ground-deep-rgb": "10, 29, 33", "--surface-rgb": "25, 58, 64",
      "--line-rgb": "44, 98, 103", "--coral-rgb": "60, 199, 183", "--blush-rgb": "240, 120, 114",
      "--accent-hover": "#50d4c4", "--accent-ink": "#092421",
      "--accent-message-ink": "#092421", "--accent-message-ink-rgb": "9, 36, 33",
    }),
  }),
  Object.freeze({
    id: "blue-hour",
    name: "Blue Hour",
    note: "Ink blue with a vivid violet service light.",
    candidate: "cand-3",
    mascot: "/theme-mascots/blue-hour.svg",
    swatches: Object.freeze(["#171A35", "#25294D", "#8178FF", "#F0EEFF"]),
    themeColor: "#171A35",
    css: Object.freeze({
      "--ground": "#171a35", "--ground-deep": "#101226", "--surface": "#25294d",
      "--surface-lift": "#323762", "--line": "#494f82", "--coral": "#8178ff",
      "--coral-dim": "#665fd0", "--blush": "#ee7199", "--ink": "#18142f",
      "--cream": "#f0eeff", "--muted": "#aba9cc", "--muted-deep": "#7d7da5",
      "--ground-glow": "#2e3261", "--surface-shade": "#1e2242",
      "--ground-deep-rgb": "16, 18, 38", "--surface-rgb": "37, 41, 77",
      "--line-rgb": "73, 79, 130", "--coral-rgb": "129, 120, 255", "--blush-rgb": "238, 113, 153",
      "--accent-hover": "#948cff", "--accent-ink": "#15112d",
      "--accent-message-ink": "#15112d", "--accent-message-ink-rgb": "21, 17, 45",
    }),
  }),
  Object.freeze({
    id: "dispatch",
    name: "Dispatch",
    note: "Brown-black boards with a warm golden call light.",
    candidate: "cand-4",
    mascot: "/theme-mascots/dispatch.svg",
    swatches: Object.freeze(["#282018", "#3A2E21", "#FFC857", "#FFF3D3"]),
    themeColor: "#282018",
    css: Object.freeze({
      "--ground": "#282018", "--ground-deep": "#1b1510", "--surface": "#3a2e21",
      "--surface-lift": "#4b3b29", "--line": "#6d5534", "--coral": "#ffc857",
      "--coral-dim": "#d3a342", "--blush": "#ed7758", "--ink": "#3d2e10",
      "--cream": "#fff3d3", "--muted": "#c2ad88", "--muted-deep": "#917c5e",
      "--ground-glow": "#4a3925", "--surface-shade": "#30251a",
      "--ground-deep-rgb": "27, 21, 16", "--surface-rgb": "58, 46, 33",
      "--line-rgb": "109, 85, 52", "--coral-rgb": "255, 200, 87", "--blush-rgb": "237, 119, 88",
      "--accent-hover": "#ffd574", "--accent-ink": "#302206",
      "--accent-message-ink": "#302206", "--accent-message-ink-rgb": "48, 34, 6",
    }),
  }),
  Object.freeze({
    id: "evergreen",
    name: "Evergreen",
    note: "Forest shadows with an emerald status lamp.",
    candidate: "cand-5",
    mascot: "/theme-mascots/evergreen.svg",
    swatches: Object.freeze(["#12251D", "#1D392C", "#45C98B", "#EAF6EF"]),
    themeColor: "#12251D",
    css: Object.freeze({
      "--ground": "#12251d", "--ground-deep": "#0c1914", "--surface": "#1d392c",
      "--surface-lift": "#284b3a", "--line": "#37664e", "--coral": "#45c98b",
      "--coral-dim": "#339b6a", "--blush": "#ef7878", "--ink": "#0f2e1f",
      "--cream": "#eaf6ef", "--muted": "#9ebcad", "--muted-deep": "#708f7e",
      "--ground-glow": "#234a38", "--surface-shade": "#173025",
      "--ground-deep-rgb": "12, 25, 20", "--surface-rgb": "29, 57, 44",
      "--line-rgb": "55, 102, 78", "--coral-rgb": "69, 201, 139", "--blush-rgb": "239, 120, 120",
      "--accent-hover": "#5bd79d", "--accent-ink": "#092519",
      "--accent-message-ink": "#092519", "--accent-message-ink-rgb": "9, 37, 25",
    }),
  }),
  Object.freeze({
    id: "afterglow",
    name: "Afterglow",
    note: "Plum night, rose signal, and soft shell highlights.",
    candidate: "cand-6",
    mascot: "/theme-mascots/afterglow.svg",
    swatches: Object.freeze(["#2B1828", "#40243A", "#FF8FA3", "#FFF0F3"]),
    themeColor: "#2B1828",
    css: Object.freeze({
      "--ground": "#2b1828", "--ground-deep": "#1d101b", "--surface": "#40243a",
      "--surface-lift": "#54304b", "--line": "#73435f", "--coral": "#ff8fa3",
      "--coral-dim": "#d66f86", "--blush": "#ffb06e", "--ink": "#3d1a22",
      "--cream": "#fff0f3", "--muted": "#c9a9b8", "--muted-deep": "#987386",
      "--ground-glow": "#542d4c", "--surface-shade": "#351e31",
      "--ground-deep-rgb": "29, 16, 27", "--surface-rgb": "64, 36, 58",
      "--line-rgb": "115, 67, 95", "--coral-rgb": "255, 143, 163", "--blush-rgb": "255, 176, 110",
      "--accent-hover": "#ffa3b3", "--accent-ink": "#35131c",
      "--accent-message-ink": "#35131c", "--accent-message-ink-rgb": "53, 19, 28",
    }),
  }),
]);

const THEME_BY_ID = new Map(THEMES.map((theme) => [theme.id, theme]));

export function themeNamed(value) {
  return THEME_BY_ID.get(value) || THEME_BY_ID.get(DEFAULT_THEME);
}

export function getTheme(storage = globalThis.localStorage) {
  try {
    const saved = storage?.getItem(THEME_STORAGE_KEY);
    return THEME_BY_ID.has(saved) ? saved : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(value, doc = globalThis.document) {
  const theme = themeNamed(value);
  if (!doc?.documentElement) return theme.id;
  const root = doc.documentElement;

  for (const choice of THEMES) {
    for (const property of Object.keys(choice.css)) root.style.removeProperty(property);
  }
  if (theme.id === DEFAULT_THEME) root.removeAttribute("data-theme");
  else {
    root.setAttribute("data-theme", theme.id);
    for (const [property, color] of Object.entries(theme.css)) root.style.setProperty(property, color);
  }

  for (const image of doc.querySelectorAll("[data-theme-mascot]")) {
    const defaultSrc = image.getAttribute("data-default-src") || "/mark.svg";
    image.setAttribute("src", theme.id === DEFAULT_THEME ? defaultSrc : theme.mascot);
  }
  for (const icon of doc.querySelectorAll("[data-theme-icon]")) {
    const defaultHref = icon.getAttribute("data-default-href") || "/favicon.svg";
    icon.setAttribute("href", theme.id === DEFAULT_THEME ? defaultHref : theme.mascot);
  }
  for (const original of doc.querySelectorAll("[data-default-mascot]")) {
    original.hidden = theme.id !== DEFAULT_THEME;
  }
  for (const alternate of doc.querySelectorAll("[data-themed-mascot]")) {
    alternate.hidden = theme.id === DEFAULT_THEME;
    if (theme.id !== DEFAULT_THEME) alternate.setAttribute("src", theme.mascot);
  }
  for (const meta of doc.querySelectorAll("meta[data-theme-color]")) {
    const original = meta.getAttribute("data-default-content") || "#161E2E";
    meta.setAttribute("content", theme.id === DEFAULT_THEME ? original : theme.themeColor);
  }
  return theme.id;
}

export function setTheme(value, storage = globalThis.localStorage, doc = globalThis.document) {
  if (!THEME_BY_ID.has(value)) throw new TypeError(`Unknown ORDERLY theme: ${String(value)}`);
  let persisted = true;
  try {
    if (value === DEFAULT_THEME) storage?.removeItem(THEME_STORAGE_KEY);
    else storage?.setItem(THEME_STORAGE_KEY, value);
  } catch {
    persisted = false;
  }
  applyTheme(value, doc);
  return { theme: value, persisted };
}

export function initTheme(storage = globalThis.localStorage, doc = globalThis.document) {
  return applyTheme(getTheme(storage), doc);
}

if (typeof document !== "undefined") initTheme();
