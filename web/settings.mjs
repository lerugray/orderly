// ORDERLY settings — reading and (narrowly) writing the gateway's config.
//
// The gateway's openclaw.json is the whole station's authority: it holds the
// sandbox ruling, the channel allowlist, the tool denies and the credential
// references. So this module is built the way you'd build a lock, not the way
// you'd build a form handler.
//
// Three independent gates stand between a browser and that file:
//
//   1. TYPED EDITS. The browser cannot name a path. It sends a small, fixed
//      envelope — model choices and model tags — which is applied by code that
//      only knows how to touch those places.
//   2. PATH ALLOWLIST. The candidate document is diffed against the original
//      and every changed path must match the allowlist. Anything else, the
//      write is refused and named.
//   3. INVARIANTS. The guarded subtrees (gateway, channels, bindings, tools,
//      commands — who the operator is — every agent's sandbox and tool policy,
//      and every provider's credential
//      reference) must come out deep-equal, and the POLICY-GUARD rulings —
//      sandbox all, elevated off — must still hold.
//
// Only then: back up beside the file, write a temp file, fsync, rename.
//
// No secret VALUE is read, returned or written anywhere in here. Credentials
// are referred to by env-var NAME only, and presence is reported as a boolean
// derived from the name alone.

import { readFile, writeFile, copyFile, rename, open, readdir, unlink, stat, mkdir } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { applyReplyStyleEdits, replyStyleView, ReplyStyleRefused } from "./reply-style.mjs";

// ---------------------------------------------------------------------------
// provider catalog — what this OpenClaw supports, and the env var each wants
// ---------------------------------------------------------------------------

// Env-var NAMES, read out of the installed OpenClaw's own provider docs
// (docs/providers/*.md, v2026.7.1-2). Names only: this table exists so the UI
// can tell the operator what to put in ~/.openclaw/.env, never to hold a value.
const PROVIDER_ENV = {
  anthropic: { label: "Anthropic", env: "ANTHROPIC_API_KEY" },
  openai: { label: "OpenAI", env: "OPENAI_API_KEY" },
  openrouter: { label: "OpenRouter", env: "OPENROUTER_API_KEY" },
  deepseek: { label: "DeepSeek", env: "DEEPSEEK_API_KEY" },
  moonshot: { label: "Moonshot (Kimi)", env: "MOONSHOT_API_KEY" },
  zai: { label: "Z.AI (GLM)", env: "ZAI_API_KEY" },
  qwen: { label: "Qwen", env: "DASHSCOPE_API_KEY" },
  groq: { label: "Groq", env: "GROQ_API_KEY" },
  mistral: { label: "Mistral", env: "MISTRAL_API_KEY" },
  xai: { label: "xAI", env: "XAI_API_KEY" },
  together: { label: "Together", env: "TOGETHER_API_KEY" },
  cerebras: { label: "Cerebras", env: "CEREBRAS_API_KEY" },
  fireworks: { label: "Fireworks", env: "FIREWORKS_API_KEY" },
  google: { label: "Google", env: "GEMINI_API_KEY" },
  minimax: { label: "MiniMax", env: "MINIMAX_API_KEY" },
  novita: { label: "Novita", env: "NOVITA_API_KEY" },
  deepinfra: { label: "DeepInfra", env: "DEEPINFRA_API_KEY" },
  perplexity: { label: "Perplexity", env: "PERPLEXITY_API_KEY" },
  "ollama-cloud": { label: "Ollama Cloud", env: "OLLAMA_API_KEY" },
  ollama: { label: "Ollama (local)", env: null },
  lmstudio: { label: "LM Studio (local)", env: null },
  vllm: { label: "vLLM (local)", env: null },
};

// The installed package's docs/providers directory is the honest answer to
// "what does this build support". Read it if we can find it; fall back to the
// table above, which is a subset, rather than claiming a number we can't see.
async function supportedProviders(docsDir) {
  let ids = null;
  if (docsDir) {
    try {
      ids = (await readdir(docsDir))
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.slice(0, -3))
        // these are directory/landing pages, not providers
        .filter((f) => f !== "index" && f !== "models" && f !== "meta");
    } catch {
      ids = null;
    }
  }
  const grounded = Boolean(ids);
  if (!ids) ids = Object.keys(PROVIDER_ENV);
  const known = [];
  const others = [];
  for (const id of ids.sort()) {
    const hit = PROVIDER_ENV[id];
    (hit ? known : others).push(
      hit ? { id, label: hit.label, env: hit.env } : { id, label: id, env: null },
    );
  }
  return { grounded, total: ids.length, known, others: others.map((o) => o.id) };
}

// ---------------------------------------------------------------------------
// env var names — never values
// ---------------------------------------------------------------------------

// Maps each variable NAME assigned across the given env files to the file it
// was found in. The value side of each line is matched but never captured,
// never stored and never returned — the regex has no group past the name.
//
// Several files, because the station legitimately uses more than one: the
// gateway's own ~/.openclaw/.env holds its bearer and the Telegram token, while
// a model key may be lifted from elsewhere by start-gateway.sh. Reading only the
// first would have this page report a credential as missing while the gateway
// was happily using it — a readout that is worse than none.
export async function envNames(paths) {
  const found = new Map();
  for (const path of paths) {
    let text;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const m = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/.exec(line);
      if (m && !found.has(m[1])) found.set(m[1], path);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// path walking + diffing
// ---------------------------------------------------------------------------

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Every leaf path in a document, in `a.b[0].c` form.
function* leaves(value, path = "") {
  if (isObj(value)) {
    const keys = Object.keys(value);
    if (!keys.length) yield path || "(root)";
    for (const k of keys) yield* leaves(value[k], path ? `${path}.${k}` : k);
  } else if (Array.isArray(value)) {
    if (!value.length) yield path;
    for (let i = 0; i < value.length; i++) yield* leaves(value[i], `${path}[${i}]`);
  } else {
    yield path;
  }
}

function at(doc, path) {
  let cur = doc;
  for (const step of path.split(/\.|(?=\[)/)) {
    if (cur === undefined || cur === null) return undefined;
    if (step.startsWith("[")) cur = cur[Number(step.slice(1, -1))];
    else if (step) cur = cur[step];
  }
  return cur;
}

// The set of paths whose value differs between two documents, in either
// direction — so an addition and a deletion both surface.
export function changedPaths(before, after) {
  const out = new Set();
  const all = new Set([...leaves(before), ...leaves(after)]);
  for (const path of all) {
    const a = at(before, path);
    const b = at(after, path);
    if (JSON.stringify(a) !== JSON.stringify(b)) out.add(path);
  }
  return [...out].sort();
}

// Gate 2. Exactly the places a model choice or a model tag lives, and nowhere
// else. Note what is absent: no gateway, no channels, no tools, no sandbox.
const ALLOWED = [
  /^agents\.defaults\.model\.primary$/,
  /^agents\.defaults\.model\.fallbacks(\[\d+\])?$/,
  /^agents\.defaults\.utilityModel$/,
  /^agents\.list\[\d+\]\.model(\.primary)?$/,
  /^models\.providers\.[A-Za-z0-9_-]+\.models\[\d+\]\.(id|name)$/,
];

// Gate 3. These subtrees must survive a write byte-identical. This is the
// POLICY-GUARD written as code rather than as a warning nobody reads.
const FROZEN = [
  "gateway",
  "channels",
  "bindings",
  "browser",
  "tools",
  // Who the operator is. `commands.ownerAllowFrom` is what makes owner-gated
  // scheduling mean anything, so moving it would be a privilege grant wearing
  // the clothes of a preference.
  "commands",
  "meta",
  "models.mode",
  "agents.defaults.workspace",
  "agents.defaults.sandbox",
  "agents.defaults.subagents",
  "agents.defaults.memorySearch",
  "agents.defaults.skills",
];

function frozenAgentPaths(doc) {
  const out = [];
  const list = doc?.agents?.list;
  if (Array.isArray(list)) {
    for (let i = 0; i < list.length; i++) {
      for (const key of ["id", "workspace", "tools", "sandbox", "subagents"]) {
        out.push(`agents.list[${i}].${key}`);
      }
    }
  }
  for (const [id, p] of Object.entries(doc?.models?.providers ?? {})) {
    for (const key of ["baseUrl", "api", "auth", "apiKey", "authHeader", "timeoutSeconds"]) {
      out.push(`models.providers.${id}.${key}`);
    }
    if (Array.isArray(p?.models)) {
      // a model entry may have its tag and label edited; everything else about
      // it — context window, token cap, capabilities — is fixed here.
      for (let i = 0; i < p.models.length; i++) {
        for (const key of ["input", "contextWindow", "maxTokens", "reasoning"]) {
          out.push(`models.providers.${id}.models[${i}].${key}`);
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// reading: what the settings page shows
// ---------------------------------------------------------------------------

function providerView(doc, present) {
  const out = [];
  for (const [id, p] of Object.entries(doc?.models?.providers ?? {})) {
    const envName = typeof p?.apiKey?.id === "string" ? p.apiKey.id : null;
    out.push({
      id,
      // A key name is not a key. The value is never read.
      apiKeyEnv: envName,
      apiKeyPresent: envName ? present.has(envName) : null,
      apiKeyIn: envName ? (present.get(envName) ?? null) : null,
      baseUrl: typeof p?.baseUrl === "string" ? p.baseUrl : null,
      api: p?.api ?? null,
      // a provider key with a dot or bracket would make a path ambiguous, so
      // its tags are shown but not offered for editing
      editable: /^[A-Za-z0-9_-]+$/.test(id),
      models: (Array.isArray(p?.models) ? p.models : []).map((m, index) => ({
        index,
        id: typeof m?.id === "string" ? m.id : "",
        name: typeof m?.name === "string" ? m.name : "",
        contextWindow: m?.contextWindow ?? null,
        maxTokens: m?.maxTokens ?? null,
        reasoning: m?.reasoning === true,
        ref: `${id}/${m?.id ?? ""}`,
      })),
    });
  }
  return out;
}

function dutyView(doc) {
  const defaults = doc?.agents?.defaults ?? {};
  const agents = (Array.isArray(doc?.agents?.list) ? doc.agents.list : []).map((a, index) => ({
    index,
    id: typeof a?.id === "string" ? a.id : `agent-${index}`,
    profile: a?.tools?.profile ?? defaults?.tools?.profile ?? null,
    sandboxMode: a?.sandbox?.mode ?? defaults?.sandbox?.mode ?? null,
    sandboxBackend: a?.sandbox?.backend ?? defaults?.sandbox?.backend ?? null,
    alsoAllow: Array.isArray(a?.tools?.alsoAllow) ? a.tools.alsoAllow : [],
    deny: Array.isArray(a?.tools?.deny) ? a.tools.deny : [],
    network: a?.sandbox?.docker?.network ?? "none",
    // the mail agent's send-disable lives in its container env; report that the
    // guard is set, never what it is set to beyond the command list itself
    disabledCommands: (a?.sandbox?.docker?.env?.GOG_DISABLE_COMMANDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    model: a?.model?.primary ?? null,
    subagents: Array.isArray(a?.subagents?.allowAgents) ? a.subagents.allowAgents : [],
  }));

  return {
    agents,
    sandbox: {
      mode: defaults?.sandbox?.mode ?? null,
      backend: defaults?.sandbox?.backend ?? null,
      elevated: doc?.tools?.elevated?.enabled === true,
      globalDeny: Array.isArray(doc?.tools?.deny) ? doc.tools.deny : [],
      globalAlsoAllow: Array.isArray(doc?.tools?.alsoAllow) ? doc.tools.alsoAllow : [],
      allSandboxed: agents.length > 0 && agents.every((a) => a.sandboxMode === "all"),
    },
    endpoints: {
      bind: doc?.gateway?.bind ?? null,
      port: doc?.gateway?.port ?? null,
      chatCompletions: doc?.gateway?.http?.endpoints?.chatCompletions?.enabled === true,
      responses: doc?.gateway?.http?.endpoints?.responses?.enabled === true,
      controlUi: doc?.gateway?.controlUi?.enabled === true,
      controlUiPath: doc?.gateway?.controlUi?.basePath ?? null,
      gatewayDeny: Array.isArray(doc?.gateway?.tools?.deny) ? doc.gateway.tools.deny : [],
      browser: doc?.browser?.enabled === true,
      authMode: doc?.gateway?.auth?.mode ?? null,
      authEnv: doc?.gateway?.auth?.token?.id ?? null,
    },
    channels: Object.entries(doc?.channels ?? {}).map(([id, ch]) => ({
      id,
      enabled: ch?.enabled === true,
      dmPolicy: ch?.dmPolicy ?? null,
      // how many are allowed through, never who
      allowFrom: Array.isArray(ch?.allowFrom) ? ch.allowFrom.length : 0,
      tokenEnv: ch?.botToken?.id ?? null,
    })),
    bindings: (Array.isArray(doc?.bindings) ? doc.bindings : []).map((b) => ({
      agentId: b?.agentId ?? null,
      channel: b?.match?.channel ?? null,
    })),
    reload: doc?.gateway?.reload?.mode ?? "hybrid",
  };
}

function replyStyleAgentIds(doc, extra = []) {
  return [...new Set([
    ...(Array.isArray(doc?.agents?.list) ? doc.agents.list.map((agent) => agent?.id) : []),
    ...extra,
  ].filter((id) => typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id)))];
}

export async function readReplyStyleRecord(replyStylePath) {
  if (!replyStylePath) return { v: 1, replyStyle: undefined };
  let raw;
  try {
    raw = await readFile(replyStylePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { v: 1, replyStyle: undefined };
    throw error;
  }
  let record;
  try { record = JSON.parse(raw); } catch { return { v: 1, replyStyle: { malformed: true } }; }
  if (!isObj(record) || record.v !== 1 || Object.keys(record).some((key) => key !== "v" && key !== "replyStyle")) {
    return { v: 1, replyStyle: { malformed: true } };
  }
  return record;
}

export async function readSettings({ configPath, envPaths, docsDir, eligibleAgentIds = [], replyStylePath = null }) {
  const raw = await readFile(configPath, "utf8");
  const doc = JSON.parse(raw);
  const present = await envNames(envPaths);
  let writable = false;
  try {
    const handle = await open(configPath, "r+");
    await handle.close();
    writable = true;
  } catch {
    writable = false;
  }

  const providers = providerView(doc, present);
  const supported = await supportedProviders(docsDir);
  // Which of the supported providers already have a credential name in the env
  // file — the honest answer to "what could I switch to without doing anything".
  for (const entry of supported.known) {
    entry.envPresent = entry.env ? present.has(entry.env) : null;
    entry.envIn = entry.env ? (present.get(entry.env) ?? null) : null;
    entry.configured = providers.some((p) => p.apiKeyEnv === entry.env);
  }

  const replyStyleRecord = await readReplyStyleRecord(replyStylePath);
  const replyStyleDoc = { orderly: { replyStyle: replyStyleRecord.replyStyle } };
  return {
    editable: {
      defaults: {
        primary: doc?.agents?.defaults?.model?.primary ?? null,
        fallbacks: Array.isArray(doc?.agents?.defaults?.model?.fallbacks)
          ? doc.agents.defaults.model.fallbacks
          : [],
        utilityModel: doc?.agents?.defaults?.utilityModel ?? null,
      },
      agents: (Array.isArray(doc?.agents?.list) ? doc.agents.list : []).map((a) => ({
        id: a?.id ?? null,
        primary: a?.model?.primary ?? null,
      })),
      providers,
    },
    duty: dutyView(doc),
    replyStyle: {
      ...replyStyleView(replyStyleDoc, replyStyleAgentIds(doc, eligibleAgentIds)),
      eligibleAgents: replyStyleAgentIds(doc, eligibleAgentIds),
    },
    supported,
    envPaths,
    writable,
    configPath: basename(configPath),
  };
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,119}$/;
// no control characters; a label is one plain line of text
const NAME_RE = /^[^\u0000-\u001f]{1,80}$/;
const MAX_FALLBACKS = 6;

class Refused extends Error {}
const refuse = (msg) => {
  throw new Refused(msg);
};

// Gate 1: apply the typed envelope. This function is the only thing in the
// process that writes into the config document, and it can only reach the
// places written here.
const ENVELOPE_KEYS = ["defaults", "agents", "modelTags"];

function applyEdits(doc, edits, eligibleAgentIds = []) {
  if (!isObj(edits)) refuse("Nothing to change.");
  // Name anything unrecognised rather than ignoring it: a caller aiming at a
  // part of the config this page doesn't own should be told so, not answered
  // with a misleading "nothing changed".
  for (const key of Object.keys(edits)) {
    if (!ENVELOPE_KEYS.includes(key)) refuse(`"${key}" is not something this page can change.`);
  }

  // Model tags first: a later model reference may point at a tag renamed here.
  if (edits.modelTags !== undefined) {
    if (!isObj(edits.modelTags)) refuse("Malformed model tags.");
    for (const [providerId, byIndex] of Object.entries(edits.modelTags)) {
      if (!/^[A-Za-z0-9_-]+$/.test(providerId)) refuse(`Unknown provider "${providerId}".`);
      const provider = doc?.models?.providers?.[providerId];
      if (!isObj(provider) || !Array.isArray(provider.models)) {
        refuse(`Unknown provider "${providerId}".`);
      }
      if (!isObj(byIndex)) refuse("Malformed model tags.");
      for (const [rawIndex, patch] of Object.entries(byIndex)) {
        const i = Number(rawIndex);
        if (!Number.isInteger(i) || i < 0 || i >= provider.models.length) {
          refuse(`No model at position ${rawIndex} for ${providerId}.`);
        }
        if (!isObj(patch)) refuse("Malformed model tags.");
        for (const key of Object.keys(patch)) {
          if (key !== "id" && key !== "name") refuse(`A model's "${key}" is not editable here.`);
        }
        if (patch.id !== undefined) {
          if (typeof patch.id !== "string" || !TAG_RE.test(patch.id)) {
            refuse(`"${String(patch.id).slice(0, 40)}" isn't a usable model tag.`);
          }
          provider.models[i].id = patch.id;
        }
        if (patch.name !== undefined) {
          if (typeof patch.name !== "string" || !NAME_RE.test(patch.name)) {
            refuse("That model label isn't usable.");
          }
          provider.models[i].name = patch.name;
        }
      }
      const seen = new Set();
      for (const m of provider.models) {
        if (seen.has(m.id)) refuse(`${providerId} would have two models tagged "${m.id}".`);
        seen.add(m.id);
      }
    }
  }

  // The set of references that exist after any tag edits.
  const known = new Set();
  for (const [providerId, provider] of Object.entries(doc?.models?.providers ?? {})) {
    for (const m of Array.isArray(provider?.models) ? provider.models : []) {
      if (typeof m?.id === "string") known.add(`${providerId}/${m.id}`);
    }
  }
  const checkRef = (ref, what) => {
    if (typeof ref !== "string" || !known.has(ref)) {
      refuse(`${what} names a model this station doesn't have configured.`);
    }
  };

  if (edits.defaults !== undefined) {
    if (!isObj(edits.defaults)) refuse("Malformed defaults.");
    for (const key of Object.keys(edits.defaults)) {
      if (!["primary", "fallbacks", "utilityModel"].includes(key)) {
        refuse(`"${key}" is not editable here.`);
      }
    }
    doc.agents ??= {};
    doc.agents.defaults ??= {};
    const d = doc.agents.defaults;

    if (edits.defaults.primary !== undefined) {
      checkRef(edits.defaults.primary, "The main model");
      d.model ??= {};
      d.model.primary = edits.defaults.primary;
    }
    if (edits.defaults.utilityModel !== undefined) {
      checkRef(edits.defaults.utilityModel, "The utility model");
      d.utilityModel = edits.defaults.utilityModel;
    }
    if (edits.defaults.fallbacks !== undefined) {
      const list = edits.defaults.fallbacks;
      if (!Array.isArray(list) || list.length > MAX_FALLBACKS) refuse("Too many fallbacks.");
      for (const ref of list) checkRef(ref, "A fallback");
      if (new Set(list).size !== list.length) refuse("The same fallback is listed twice.");
      const primary = edits.defaults.primary ?? d?.model?.primary;
      if (list.includes(primary)) refuse("A fallback can't be the main model.");
      d.model ??= {};
      d.model.fallbacks = list;
    }
  }

  if (edits.agents !== undefined) {
    if (!isObj(edits.agents)) refuse("Malformed agent settings.");
    const list = Array.isArray(doc?.agents?.list) ? doc.agents.list : [];
    for (const [agentId, patch] of Object.entries(edits.agents)) {
      const agent = list.find((a) => a?.id === agentId);
      if (!agent) refuse(`There is no "${agentId}" agent.`);
      if (!isObj(patch)) refuse("Malformed agent settings.");
      for (const key of Object.keys(patch)) {
        if (key !== "primary") refuse(`An agent's "${key}" is not editable here.`);
      }
      if (patch.primary === null || patch.primary === "") {
        // back to inheriting the station default
        if (isObj(agent.model)) {
          delete agent.model.primary;
          if (!Object.keys(agent.model).length) delete agent.model;
        }
      } else if (patch.primary !== undefined) {
        checkRef(patch.primary, `The model for "${agentId}"`);
        agent.model = { ...(isObj(agent.model) ? agent.model : {}), primary: patch.primary };
      }
    }
  }

  return doc;
}

// Gate 2, for the engine-definition class only. An endpoint edit is not a model
// edit — `baseUrl` decides where the gateway sends its traffic, `api` decides
// how the answer is read, and `auth` decides what credential goes with it — so
// it gets its own allowlist rather than being let in through the model-tag one.
// This one permits exactly two shapes: a provider that did not exist before, and
// model entries appended past the end of an existing provider's list. It cannot
// express a change to anything that was already there.
function engineDefinitionAllowlist(providerId, existingModelCount) {
  const id = providerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [new RegExp(`^models\\.providers\\.${id}\\.(baseUrl|api|auth|authHeader|timeoutSeconds)$`)];
  patterns.push(new RegExp(`^models\\.providers\\.${id}\\.apiKey\\.(source|provider|id)$`));
  // Appended entries only. An index inside the existing range would be an edit
  // to a model the operator already has, which is the other page's business.
  patterns.push(
    new RegExp(`^models\\.providers\\.${id}\\.models\\[(\\d+)\\]\\.(id|name|input\\[\\d+\\]|contextWindow|maxTokens)$`),
  );
  return (path) => {
    for (const re of patterns) {
      const m = re.exec(path);
      if (!m) continue;
      if (re.source.includes("models\\[")) {
        const index = Number(/models\[(\d+)\]/.exec(path)?.[1]);
        if (!Number.isInteger(index) || index < existingModelCount) return false;
      }
      return true;
    }
    return false;
  };
}

const API_MODES = ["openai-completions"];
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// The second edge of the identity split. A definition names the environment
// variable a provider's key is read from — the desk deals in NAMES, never
// values, and no secret VALUE passes through here. But a NAME is not harmless
// when the gateway process already holds that variable for something else: if a
// definition names the gateway bearer or a channel token, a seat later pointed
// at that provider would have the GATEWAY read the named variable and send it to
// the definition's baseUrl — a credential the desk never saw, exfiltrated in a
// second step from a definition it was allowed to store. So the desk must never
// be the place a privileged secret gets wired into a provider definition, even
// by name alone. Naming an ordinary provider key (a variable the operator adds
// for the endpoint) stays allowed; the spec's own §6 keeps the credential-
// reference-by-name path open for a genuinely authenticated operator endpoint.
//
// These names are refused whatever the config says, so the guarantee does not
// depend on the config's shape staying the way it is today.
const RESERVED_ENV_FLOOR = Object.freeze([
  "OPENCLAW_GATEWAY_TOKEN", // the gateway bearer — operator-equivalent (README security posture)
  "TELEGRAM_BOT_TOKEN", // the Telegram channel token — a station secret
  "GOG_KEYRING_PASSWORD", // the mail agent's keyring password — a station secret
]);

// Reads the reserved set out of the config the write is about to touch, so a
// station that renames its bearer or adds a channel is covered without a code
// change. Three privileged positions hold an env-var NAME the gateway process
// holds for something other than an ordinary provider key:
//   - gateway.auth.token.id    the bearer, equivalent to operator access
//   - channels.*.botToken.id   each channel's bot token
//   - a sandbox container env NAME whose value is a never-commit placeholder,
//     i.e. a secret the gateway injects into an agent (e.g. GOG_KEYRING_PASSWORD)
function reservedEnvNames(doc) {
  const reserved = new Set(RESERVED_ENV_FLOOR);
  const bearer = doc?.gateway?.auth?.token?.id;
  if (typeof bearer === "string") reserved.add(bearer);
  for (const ch of Object.values(doc?.channels ?? {})) {
    if (typeof ch?.botToken?.id === "string") reserved.add(ch.botToken.id);
  }
  for (const agent of Array.isArray(doc?.agents?.list) ? doc.agents.list : []) {
    const env = agent?.sandbox?.docker?.env;
    if (!isObj(env)) continue;
    for (const [name, val] of Object.entries(env)) {
      if (typeof val === "string" && /NEVER_COMMIT|^\s*<FROM_ENV/i.test(val)) reserved.add(name);
    }
  }
  return reserved;
}

// The engine-definition edit: add a provider for an endpoint the operator runs,
// or add a model tag to one they already added. It writes no credential VALUE —
// `apiKeyEnv` is the NAME of an environment variable and nothing else — and a
// local endpoint that needs no key is spelled `auth: "none"`, with no
// placeholder key invented for it.
export async function writeProviderDefinition({ configPath, definition }) {
  if (!isObj(definition)) refuse("Nothing to define.");
  for (const key of Object.keys(definition)) {
    if (!["providerId", "baseUrl", "api", "auth", "apiKeyEnv", "timeoutSeconds", "models"].includes(key)) {
      refuse(`"${key}" is not part of an engine definition.`);
    }
  }
  const { providerId } = definition;
  if (typeof providerId !== "string" || !/^[A-Za-z0-9_-]+$/.test(providerId)) {
    refuse("A provider name may hold letters, digits, dashes and underscores.");
  }
  if (!API_MODES.includes(definition.api)) {
    refuse(`This station speaks ${API_MODES.join(", ")} to an endpoint, and will not claim to speak anything else.`);
  }
  if (definition.auth !== "none" && definition.auth !== "api-key") {
    refuse('A provider is either "none" — a local endpoint wanting no key — or "api-key".');
  }
  if (definition.auth === "api-key") {
    if (typeof definition.apiKeyEnv !== "string" || !ENV_NAME_RE.test(definition.apiKeyEnv)) {
      refuse("A key-using provider names the environment variable its key is read from.");
    }
  } else if (definition.apiKeyEnv !== undefined) {
    refuse("A provider that needs no key names no environment variable.");
  }
  let parsed;
  try {
    parsed = new URL(definition.baseUrl);
  } catch {
    refuse("That endpoint isn't a readable web address.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    refuse("An endpoint is reached over http or https.");
  }
  if (parsed.username || parsed.password) {
    refuse("That address carries a credential in it. Name an environment variable instead.");
  }
  if (definition.timeoutSeconds !== undefined) {
    if (!Number.isInteger(definition.timeoutSeconds) || definition.timeoutSeconds < 1 || definition.timeoutSeconds > 600) {
      refuse("A timeout is a whole number of seconds between 1 and 600.");
    }
  }
  const models = definition.models;
  if (!Array.isArray(models) || !models.length) refuse("An engine definition names at least one model tag.");
  for (const m of models) {
    if (!isObj(m)) refuse("Malformed model entry.");
    for (const key of Object.keys(m)) {
      if (!["id", "name", "contextWindow", "maxTokens"].includes(key)) {
        refuse(`A model entry has no "${key}".`);
      }
    }
    if (typeof m.id !== "string" || !TAG_RE.test(m.id)) refuse(`"${String(m.id).slice(0, 40)}" isn't a usable model tag.`);
    if (m.name !== undefined && (typeof m.name !== "string" || !NAME_RE.test(m.name))) {
      refuse("That model label isn't usable.");
    }
    if (!Number.isInteger(m.contextWindow) || m.contextWindow < 1) refuse(`${m.id} needs a contextWindow in tokens.`);
    if (!Number.isInteger(m.maxTokens) || m.maxTokens < 1) refuse(`${m.id} needs a maxTokens in tokens.`);
    if (m.maxTokens >= m.contextWindow) refuse(`${m.id} reserves more for the reply than its whole context window.`);
  }

  const raw = await readFile(configPath, "utf8");
  const before = JSON.parse(raw);

  // Before anything is built or stored: a key-using definition may not name a
  // variable the gateway already holds as a secret. The desk stores only the
  // NAME, but wiring a privileged NAME into a provider is a capability grant —
  // a later seat would have the gateway read it and send it to this endpoint.
  if (definition.auth === "api-key" && reservedEnvNames(before).has(definition.apiKeyEnv)) {
    refuse(
      `"${definition.apiKeyEnv}" is a credential the gateway already holds; it can't be wired in as a provider key from this desk. Name an ordinary provider key instead.`,
    );
  }

  const after = JSON.parse(raw);
  after.models ??= {};
  after.models.providers ??= {};
  const existing = before?.models?.providers?.[providerId];
  const existingModels = Array.isArray(existing?.models) ? existing.models : [];

  if (existing) {
    // A provider that already exists may be extended, never redirected: its
    // endpoint, protocol and credential reference are frozen below, and saying
    // so here makes the refusal readable rather than a surprise at gate 3.
    if (existing.baseUrl !== definition.baseUrl || existing.api !== definition.api) {
      refuse(
        `${providerId} already exists here and points somewhere else. This page adds an endpoint or adds a tag to one; it does not move an existing endpoint.`,
      );
    }
    const known = new Set(existingModels.map((m) => m?.id));
    const additions = models.filter((m) => !known.has(m.id));
    if (!additions.length) refuse(`${providerId} already has ${models.length === 1 ? "that tag" : "those tags"}.`);
    after.models.providers[providerId].models = [
      ...existingModels,
      ...additions.map((m) => ({
        id: m.id,
        ...(m.name ? { name: m.name } : {}),
        input: ["text"],
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
      })),
    ];
  } else {
    const seen = new Set();
    for (const m of models) {
      if (seen.has(m.id)) refuse(`${providerId} would have two models tagged "${m.id}".`);
      seen.add(m.id);
    }
    after.models.providers[providerId] = {
      baseUrl: definition.baseUrl,
      api: definition.api,
      auth: definition.auth,
      ...(definition.auth === "api-key"
        ? { apiKey: { source: "env", provider: "default", id: definition.apiKeyEnv }, authHeader: true }
        : {}),
      timeoutSeconds: definition.timeoutSeconds ?? 120,
      models: models.map((m) => ({
        id: m.id,
        ...(m.name ? { name: m.name } : {}),
        input: ["text"],
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
      })),
    };
  }

  const allowed = engineDefinitionAllowlist(providerId, existingModels.length);
  const changed = changedPaths(before, after);
  if (!changed.length) refuse("Nothing changed.");
  for (const path of changed) {
    if (!allowed(path)) {
      refuse(`Refused: that would have changed ${path}, which an engine definition may not touch.`);
    }
  }
  // Gate 3, unchanged and shared with the ordinary edit: every guarded subtree,
  // every existing agent, and every provider that was already here — including
  // its credential reference — comes out byte-identical.
  for (const path of [...FROZEN, ...frozenAgentPaths(before)]) {
    if (JSON.stringify(at(before, path)) !== JSON.stringify(at(after, path))) {
      refuse(`Refused: ${path} must not change.`);
    }
  }
  if (after?.agents?.defaults?.sandbox?.mode !== "all") refuse("Refused: every session must stay sandboxed.");
  if (after?.tools?.elevated?.enabled === true) refuse("Refused: elevated tools must stay off.");

  const written = await persist(configPath, after);
  return { changed, ...written };
}

async function pruneBackups(dir, keep) {
  try {
    const names = (await readdir(dir))
      .filter((n) => /^openclaw\.json\.orderly-bak-/.test(n))
      .sort();
    for (const name of names.slice(0, Math.max(0, names.length - keep))) {
      await unlink(join(dir, name)).catch(() => {});
    }
  } catch {
    /* pruning is housekeeping, never a reason to fail a write */
  }
}

// The whole write, gates and all. Returns what changed; throws Refused with an
// operator-readable reason if any gate says no.
export async function writeSettings({ configPath, edits, eligibleAgentIds = [] }) {
  const raw = await readFile(configPath, "utf8");
  const before = JSON.parse(raw);
  const after = applyEdits(JSON.parse(raw), edits, eligibleAgentIds);

  // Gate 2 — every changed path must be one we meant to offer.
  const changed = changedPaths(before, after);
  if (!changed.length) refuse("Nothing changed.");
  for (const path of changed) {
    if (!ALLOWED.some((re) => re.test(path))) {
      refuse(`Refused: that would have changed ${path}, which this page may not touch.`);
    }
  }

  // Gate 3 — the guarded subtrees, byte for byte.
  for (const path of [...FROZEN, ...frozenAgentPaths(before)]) {
    if (JSON.stringify(at(before, path)) !== JSON.stringify(at(after, path))) {
      refuse(`Refused: ${path} must not change.`);
    }
  }
  // ...and the two rulings POLICY-GUARD says never to flip.
  if (after?.agents?.defaults?.sandbox?.mode !== "all") {
    refuse("Refused: every session must stay sandboxed.");
  }
  if (after?.tools?.elevated?.enabled === true) {
    refuse("Refused: elevated tools must stay off.");
  }

  const written = await persist(configPath, after);
  return { changed, ...written };
}

const REPLY_ALLOWED = [
  /^orderly\.replyStyle$/,
  /^orderly\.replyStyle\.(station|agents)$/,
  /^orderly\.replyStyle\.station\.(instructions|presets)$/,
  /^orderly\.replyStyle\.station\.presets\.[a-z0-9-]+$/,
  /^orderly\.replyStyle\.agents\.[A-Za-z0-9_-]+$/,
  /^orderly\.replyStyle\.agents\.[A-Za-z0-9_-]+\.(instructions|presets)$/,
  /^orderly\.replyStyle\.agents\.[A-Za-z0-9_-]+\.presets\.[a-z0-9-]+$/,
];

export async function writeReplyStyle({ replyStylePath, edits, eligibleAgentIds = [] }) {
  if (!replyStylePath) refuse("Reply-style storage is not configured on this station.");
  const record = await readReplyStyleRecord(replyStylePath);
  const before = { orderly: { replyStyle: record.replyStyle } };
  const after = JSON.parse(JSON.stringify(before));
  try {
    applyReplyStyleEdits(after, edits, eligibleAgentIds);
  } catch (error) {
    if (error instanceof ReplyStyleRefused) refuse(error.message);
    throw error;
  }
  const changed = changedPaths(before, after);
  if (!changed.length) refuse("Nothing changed.");
  for (const path of changed) {
    if (!REPLY_ALLOWED.some((pattern) => pattern.test(path))) {
      refuse(`Refused: that would have changed ${path}, which reply style may not touch.`);
    }
  }
  const dir = dirname(replyStylePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let backup = null;
  try {
    await stat(replyStylePath);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backup = `${basename(replyStylePath)}.orderly-bak-${stamp}`;
    await copyFile(replyStylePath, join(dir, backup));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const tmp = join(dir, `.${basename(replyStylePath)}.tmp-${process.pid}-${Date.now()}`);
  const body = `${JSON.stringify({ v: 1, replyStyle: after.orderly.replyStyle }, null, 2)}\n`;
  await writeFile(tmp, body, { mode: 0o600 });
  const handle = await open(tmp, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
  await rename(tmp, replyStylePath);
  try {
    const prefix = `${basename(replyStylePath)}.orderly-bak-`;
    const backups = (await readdir(dir)).filter((name) => name.startsWith(prefix)).sort();
    for (const name of backups.slice(0, Math.max(0, backups.length - 10))) {
      await unlink(join(dir, name)).catch(() => {});
    }
  } catch {
    // Backup pruning is housekeeping; the authoritative write already completed.
  }
  return { changed, backup, bytes: Buffer.byteLength(body), reloadRequired: false };
}

// Back up beside the file, write a temp file, fsync, rename. Atomic: a full
// file appears at the real path or nothing does, because a half-written config
// would take the station down until someone noticed. Shared by both edit
// classes so neither can drift into a less careful write.
async function persist(configPath, after) {
  const dir = dirname(configPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `openclaw.json.orderly-bak-${stamp}`;
  const info = await stat(configPath);
  await copyFile(configPath, join(dir, backup));

  const tmp = join(dir, `.openclaw.json.orderly-tmp-${process.pid}-${Date.now()}`);
  const body = `${JSON.stringify(after, null, 2)}\n`;
  await writeFile(tmp, body, { mode: info.mode & 0o777 });
  const handle = await open(tmp, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, configPath);
  await pruneBackups(dir, 10);

  return { backup, bytes: Buffer.byteLength(body) };
}

export { Refused };
