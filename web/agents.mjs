// ORDERLY — named persistent agents, milestone 1: the identity store.
//
// Grounded in docs/SPEC-NAMED-AGENTS-FUGU-2026-08-21.md (ratified). This module
// owns §1's record and on-disk layout, §4's persistence, and the half of §5 that
// is not a browser. It deliberately does NOT own §2 (per-agent Docker sandboxes),
// §3.3 (mentions), §3.4 (group agents) or the Telegram attachment — those are the
// spec's own deferrals and the milestones after this one.
//
// The one property this file exists to make STRUCTURAL rather than promised:
//
//   CREATING AN AGENT CANNOT PROVISION A CREDENTIAL, A PATH, A MOUNT, AN IMAGE,
//   A NETWORK DESTINATION OR AN ENVIRONMENT VARIABLE — because there is no code
//   here that can write one, and because a record that merely LOOKS like it
//   carries one is refused before it reaches the disk.
//
// That is spec §7's first anti-goal turned into three gates, in the shape
// settings.mjs already uses for the gateway config:
//
//   1. TYPED ENVELOPE. A caller sends a small fixed set of fields — a name, a
//      description, a handle, a memory policy. Anything else is refused BY NAME,
//      so a caller aiming at a part of the record this surface does not own is
//      told so rather than silently ignored.
//   2. SHAPE REFUSAL. The free-text fields are checked against the shapes a
//      credential, a filesystem path, a container image, a URL or an env
//      assignment actually take. A description is prose about a purpose; it is
//      not a place to smuggle a mount.
//   3. RECORD INVARIANT. The finished record is walked key by key and value by
//      value before it is written. A forbidden key name, a path-shaped or
//      secret-shaped string, a non-empty capability or delegation list, or a
//      channel binding other than the web desk all refuse the whole write.
//
// Where the store lives is the deployment's business, not this module's: every
// entry point takes a `root`. See web/server.mjs for how the front door resolves
// it and LANE-REPORT-NAMEDAGENTS-M1.md for why M1's root is the desk's own host
// state rather than §1.1's gateway-owned path — in one line, because M1 creates
// no sandbox and grants no capability, so there is no security-defining field
// for the gateway to be the owner OF, and the front door cannot write into an
// identity it is deliberately not.
//
// The LAYOUT under that root is the spec's, exactly:
//
//   <root>/identity-manifest.json
//   <root>/agents/<agent-id>/profile.json          read-only projection
//   <root>/agents/<agent-id>/standing-orders.md    host-managed, read-only
//   <root>/agents/<agent-id>/memory/MEMORY.md      persistent agents only
//   <root>/agents/<agent-id>/memory/notes/         persistent agents only
//   <root>/agents/<agent-id>/conversations/        the canonical transcript
//   <root>/agents/<agent-id>/media/
//   <root>/agents/<agent-id>/audit/events.jsonl

import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { FIXED_REPLY_STYLE_CONTRACT } from "./reply-style.mjs";

export class AgentsRefused extends Error {}
const refuse = (message) => {
  throw new AgentsRefused(message);
};

// ---------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------

export const AGENT_ID = /^a-[a-z0-9]{8,40}$/;
export const AGENT_HANDLE = /^[a-z0-9][a-z0-9-]{1,30}$/;

const NAME_MAX = 60;
const DESCRIPTION_MAX = 600;
const AGENTS_MAX = 24;
const TURN_MAX_CHARS = 6000;
const TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024;
const TRANSCRIPT_KEEP_TURNS = 400;
const TRANSCRIPT_READ_MAX = 200;
const AUDIT_MAX_BYTES = 512 * 1024;

// The fixed trio and the words the station already uses for itself. A named
// agent called "mail" would not GET the mail profile — §2.1 is explicit that
// naming does not grant — but it would make the desk lie about which identity
// answered, which is its own harm.
const RESERVED_HANDLES = new Set([
  "coordinator", "mail", "researcher", "research", "orchestration", "orchestrator",
  "orderly", "system", "admin", "root", "gateway", "broker", "calendar", "web",
  "agent", "agents", "new", "settings", "dashboard", "console", "me", "you",
]);

// Gate 2. What a credential, a path, an image, an endpoint or an environment
// assignment actually looks like. A purpose statement needs none of these, so
// refusing them costs the operator nothing and closes the smuggling route.
const SHAPES = [
  [/(^|[\s"'(])(\/|~\/|\.\.\/|[A-Za-z]:\\)/, "a filesystem path"],
  [/\b[a-z][a-z0-9+.-]*:\/\//i, "a URL"],
  [/\b[A-Z][A-Z0-9_]{3,}\s*=/, "an environment assignment"],
  [/\b(sk|pk|ghp|gho|ghu|ghs|xox[abprs]|bearer)[-_ ]?[A-Za-z0-9_-]{12,}/i, "a credential"],
  [/-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)/, "a key or certificate"],
];

// Gate 3. Key names a record of this kind must never carry. The list is of
// NAMES, not values: a record that has grown a `token` key has grown a place to
// put one, and that is the failure whether or not it is filled in yet.
const FORBIDDEN_KEYS =
  /^(token|secret|api_?key|key|keys|credential|credentials|env|environment|mount|mounts|volume|volumes|image|images|dockerfile|network|networks|password|passphrase|bearer|auth|authorization|socket|sockets|entrypoint|command|cmd|args|exec|shell|host|hosts|hostPath|privileged|capabilities_add)$/i;

function isObj(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function plainText(value, max, what) {
  if (typeof value !== "string") refuse(`${what} has to be text.`);
  const clean = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length > max) refuse(`${what} is longer than ${max} characters.`);
  for (const [shape, called] of SHAPES) {
    if (shape.test(clean)) {
      refuse(
        `${what} reads like ${called}. A named agent is a name and a purpose — it holds no path, endpoint or credential, and this station will not record one.`,
      );
    }
  }
  return clean;
}

// A handle is derived from the name unless the operator gives one, because
// asking for both up front is a form to fill in rather than a thing to name.
export function handleFrom(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/, "");
}

function newId() {
  return `a-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.replace(
    /[^a-z0-9-]/g,
    "",
  );
}

function newConversationId() {
  return `c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.replace(
    /[^a-z0-9-]/g,
    "",
  );
}

// ---------------------------------------------------------------------------
// gate 3 — the record invariant
// ---------------------------------------------------------------------------

export function assertCredentialFree(record) {
  // The one string in the record that legitimately begins with a slash is
  // §1.2's `path`, which is a DESK ROUTE and not a filesystem path. It is
  // derived from the handle and never supplied, so it is checked against that
  // derivation rather than against the smuggling shapes — and a `path` that is
  // anything else at all refuses the write.
  if (record?.path !== `/agents/${record?.handle}`) {
    refuse("Refused: an agent's route is derived from its handle and cannot be set.");
  }

  const walk = (value, path) => {
    if (isObj(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.test(key)) {
          refuse(`Refused: an agent record may not carry a "${key}" field.`);
        }
        if (path === "" && key === "path") continue;
        walk(child, path ? `${path}.${key}` : key);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) => walk(child, `${path}[${index}]`));
      return;
    }
    if (typeof value !== "string") return;
    for (const [shape, called] of SHAPES) {
      if (shape.test(value)) refuse(`Refused: ${path} reads like ${called}.`);
    }
  };
  walk(record, "");

  // The three lists §2.2 and §7 say are empty until a separate operator ruling
  // fills them, asserted rather than assumed.
  if (!Array.isArray(record.capabilityBindings) || record.capabilityBindings.length) {
    refuse("Refused: a named agent is created with no typed capabilities.");
  }
  if (!Array.isArray(record.delegationAllowlist) || record.delegationAllowlist.length) {
    refuse("Refused: delegation is off by default and is not granted at creation.");
  }
  const channels = Array.isArray(record.channelBindings) ? record.channelBindings : null;
  if (!channels || channels.length !== 1 || channels[0]?.channel !== "web-desk") {
    refuse("Refused: the web desk is the only channel a named agent is created on.");
  }
  if (record.isGroup !== false || (record.memberIds ?? []).length) {
    refuse("Refused: group agents are not part of this version.");
  }
  return record;
}

// ---------------------------------------------------------------------------
// the manifest
// ---------------------------------------------------------------------------

const EMPTY_MANIFEST = { v: 1, agents: [], tombstones: [], updatedAt: null };

function manifestPath(root) {
  return join(root, "identity-manifest.json");
}

export function agentDir(root, id) {
  if (!AGENT_ID.test(String(id))) refuse("That isn't an agent on this station.");
  return join(root, "agents", id);
}

export async function readManifest(root) {
  let raw;
  try {
    raw = await readFile(manifestPath(root), "utf8");
  } catch {
    // No manifest is the normal state of a station whose operator has created
    // no agents, and it is the state migration §6 has to leave untouched: a
    // read never writes, so a station with no agents keeps no agent files.
    return { ...EMPTY_MANIFEST, agents: [], tombstones: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Refusing loudly beats guessing: a corrupt manifest could otherwise be
    // "repaired" into a shorter roster, which is silent identity deletion.
    refuse("The agent manifest on this station could not be read as JSON. Nothing was changed.");
  }
  const agents = (Array.isArray(parsed?.agents) ? parsed.agents : [])
    .filter((record) => AGENT_ID.test(String(record?.id)) && AGENT_HANDLE.test(String(record?.handle)))
    .slice(0, AGENTS_MAX);
  const tombstones = (Array.isArray(parsed?.tombstones) ? parsed.tombstones : [])
    .filter((stone) => AGENT_HANDLE.test(String(stone?.handle)))
    .slice(-200);
  return { v: 1, agents, tombstones, updatedAt: parsed?.updatedAt ?? null };
}

async function writeManifest(root, manifest) {
  const body = JSON.stringify({ ...manifest, v: 1, updatedAt: new Date().toISOString() }, null, 2);
  const target = manifestPath(root);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(tmp, `${body}\n`, { mode: 0o600 });
  await rename(tmp, target);
}

// One writer at a time. The handlers are not, and two creations landing together
// would otherwise read the same manifest and one identity would vanish.
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
// the record
// ---------------------------------------------------------------------------

const LIFECYCLES = new Set(["pending", "active", "suspended", "retired"]);
const MEMORY_POLICIES = new Set(["persistent", "memoryless"]);

// §1.2's schema. Every field the spec names is present; the ones this milestone
// does not implement are present and FIXED, so the format need not be broken
// later and so a reader can see at a glance what is not wired rather than
// guessing from an absence.
function buildRecord({ id, name, handle, description, memoryPolicy, at }) {
  return {
    id,
    name,
    handle,
    // §1.2's `path` is a DESK ROUTE, not a filesystem path — it is what the
    // browser puts in its address bar, and it is derived, never supplied.
    path: `/agents/${handle}`,
    description,
    avatarRef: null,
    createdAt: at,
    updatedAt: at,
    // §5.2: the first confirmation creates a PENDING identity, and activation
    // waits on probes run from inside a real container. M1 builds no container,
    // so nothing here may claim to have passed them.
    lifecycle: "pending",
    agentClass: "named",
    // §2.1's `named-isolated` profile arrives with the sandbox milestone. Null
    // is the honest value: this identity has no sandbox of its own yet.
    runtimeProfile: null,
    memoryPolicy,
    canonicalConversationId: newConversationId(),
    policyRef: "standing-orders.md",
    policyRevision: 1,
    capabilityBindings: [],
    delegationAllowlist: [],
    channelBindings: [{ channel: "web-desk" }],
    isGroup: false,
    memberIds: [],
    systemLocked: false,
    // Declared, never populated here. The shape is the sibling spec's
    // (docs/SPEC-LOCAL-MODEL-SEATS-FUGU-2026-08-21.md §1.2): a per-seat model
    // override with the same primary/fallbacks semantics as agents.defaults,
    // plus the three values every effective binding must resolve. This module
    // implements no engine plumbing and refuses any attempt to write these from
    // the desk; the field exists so that lane can fill it without a migration.
    seat: {
      model: { primary: null, fallbacks: [] },
      contextBudget: null,
      capabilityTier: null,
      harnessRef: null,
    },
  };
}

// §3.1 — what `orderly-web` is allowed to hand a browser: names, handles,
// descriptions, lifecycle and non-secret labels. No filesystem path, no profile,
// no policy body, and nothing about where any of it is stored.
export function sanitise(record) {
  return {
    id: record.id,
    name: record.name,
    handle: record.handle,
    path: record.path,
    description: record.description,
    lifecycle: record.lifecycle,
    agentClass: record.agentClass,
    memoryPolicy: record.memoryPolicy,
    systemLocked: record.systemLocked === true,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    capabilities: [],
    delegation: [],
    channels: record.channelBindings.map((binding) => binding.channel),
    sandbox: { provisioned: record.runtimeProfile !== null, profile: record.runtimeProfile },
  };
}

// ---------------------------------------------------------------------------
// the per-agent directory
// ---------------------------------------------------------------------------

const STANDING_ORDERS = (record) =>
  [
    `# Standing orders — ${record.name}`,
    "",
    "Host-managed. This file is written by the station and mounted read-only; the",
    "agent cannot change it and neither can the web desk.",
    "",
    `You are "${record.name}", a named identity on a private, single-operator station.`,
    "",
    record.description
      ? `Your purpose, in the operator's own words: ${record.description}`
      : "You have no stated purpose yet. Ask the operator for one.",
    "",
    "## What you are, exactly",
    "",
    "- You are a separate identity with your own conversation and your own transcript.",
    "- You hold no credential of any kind, and no path to one.",
    "- You have no network of your own.",
    "- Delegation is off: you may not ask the mail agent, the researcher, the",
    "  coordinator or any other identity to do work on your behalf.",
    "- You cannot read another identity's memory, notes or transcript.",
    "",
    "If something you are asked for needs a capability you do not have, say so",
    "plainly and stop. Do not describe a way around it.",
    "",
    "## Reply-style preferences",
    "",
    FIXED_REPLY_STYLE_CONTRACT,
    "",
  ].join("\n");

async function layOutDirectory(root, record) {
  const dir = agentDir(root, record.id);
  await mkdir(join(dir, "conversations"), { recursive: true, mode: 0o700 });
  await mkdir(join(dir, "media"), { recursive: true, mode: 0o700 });
  await mkdir(join(dir, "audit"), { recursive: true, mode: 0o700 });
  if (record.memoryPolicy === "persistent") {
    await mkdir(join(dir, "memory", "notes"), { recursive: true, mode: 0o700 });
    const memory = join(dir, "memory", "MEMORY.md");
    try {
      await stat(memory);
    } catch {
      await writeFile(memory, `# ${record.name} — memory\n\n`, { mode: 0o600 });
    }
  }
  await writeProfile(root, record);
  await writeStandingOrders(root, record);
}

// Host-managed and mounted read-only, per §1.3 — so it is laid down the same
// way profile.json is: written elsewhere, renamed into place, then sealed. A
// rename replaces a 0444 file where a write to it would be refused, which is
// exactly the property that lets the host revise orders the agent cannot.
async function writeStandingOrders(root, record) {
  const target = join(agentDir(root, record.id), "standing-orders.md");
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, STANDING_ORDERS(record), { mode: 0o600 });
  await rename(tmp, target);
  await chmod(target, 0o444);
}

// §1.3 — a read-only, non-authoritative projection of the record. The manifest
// stays the authority; this is what a sandbox would be handed, and it is written
// 0444 so the identity it describes cannot edit its own description of itself.
async function writeProfile(root, record) {
  const target = join(agentDir(root, record.id), "profile.json");
  const body = `${JSON.stringify(sanitise(record), null, 2)}\n`;
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, body, { mode: 0o600 });
  await rename(tmp, target);
  await chmod(target, 0o444);
}

async function audit(root, id, event, detail) {
  const file = join(agentDir(root, id), "audit", "events.jsonl");
  try {
    const info = await stat(file).catch(() => null);
    if (info && info.size > AUDIT_MAX_BYTES) return;
    await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`, {
      mode: 0o600,
    });
  } catch {
    // An audit line that cannot be written is not a reason to fail the act it
    // describes; the manifest's own updatedAt still moves.
  }
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

export async function listAgents({ root }) {
  const manifest = await readManifest(root);
  return manifest.agents.map(sanitise);
}

export async function findAgent({ root, id }) {
  if (typeof id !== "string" || !AGENT_ID.test(id)) return null;
  const manifest = await readManifest(root);
  return manifest.agents.find((record) => record.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// creating and managing — §5.1's bounded verbs, and nothing else
// ---------------------------------------------------------------------------

const CREATE_KEYS = ["name", "description", "handle", "memoryPolicy"];

export function createAgent({ root, fields }) {
  if (!isObj(fields)) refuse("Nothing to create.");
  for (const key of Object.keys(fields)) {
    if (!CREATE_KEYS.includes(key)) {
      refuse(
        `"${key}" is not something an agent is created with. A named agent is a name, a purpose and a memory policy — nothing else is settable from this desk.`,
      );
    }
  }
  const name = plainText(fields.name, NAME_MAX, "A name");
  if (!name) refuse("An agent needs a name.");
  const description = fields.description === undefined || fields.description === null
    ? ""
    : plainText(fields.description, DESCRIPTION_MAX, "A description");
  const memoryPolicy = fields.memoryPolicy ?? "persistent";
  if (!MEMORY_POLICIES.has(memoryPolicy)) {
    refuse("An agent is either persistent or memoryless.");
  }
  const handle = fields.handle === undefined || fields.handle === null
    ? handleFrom(name)
    : String(fields.handle).toLowerCase().trim();
  if (!AGENT_HANDLE.test(handle)) {
    refuse(
      "A handle is two to thirty characters of lowercase letters, digits and hyphens, starting with a letter or digit.",
    );
  }

  return serialise(async () => {
    const manifest = await readManifest(root);
    if (manifest.agents.length >= AGENTS_MAX) {
      refuse(`This station holds at most ${AGENTS_MAX} named agents.`);
    }
    assertHandleFree(manifest, handle);
    const at = new Date().toISOString();
    const record = assertCredentialFree(
      buildRecord({ id: newId(), name, handle, description, memoryPolicy, at }),
    );
    await layOutDirectory(root, record);
    manifest.agents.push(record);
    await writeManifest(root, manifest);
    await audit(root, record.id, "created", { name, handle, memoryPolicy });
    return sanitise(record);
  });
}

function assertHandleFree(manifest, handle, exceptId = null) {
  if (RESERVED_HANDLES.has(handle)) {
    refuse(`"${handle}" is one of the station's own names. Choose another.`);
  }
  const taken = manifest.agents.find(
    (record) => record.handle.toLowerCase() === handle && record.id !== exceptId,
  );
  if (taken) refuse(`"${handle}" is already ${taken.name}'s handle.`);
  // §1.2 and §5.4: an old handle stays reserved after a rename or a removal, so
  // it can never be reassigned to a different identity. Someone who addressed
  // the old name must not reach a stranger.
  const stone = manifest.tombstones.find((entry) => entry.handle === handle && entry.id !== exceptId);
  if (stone) {
    refuse(
      `"${handle}" belonged to an identity that was ${stone.reason ?? "retired"}. Handles are never reused, so someone addressing the old name can never reach a stranger.`,
    );
  }
}

const RENAME_KEYS = ["name", "description", "handle"];

export function updateAgent({ root, id, fields }) {
  if (!isObj(fields)) refuse("Nothing to change.");
  for (const key of Object.keys(fields)) {
    if (!RENAME_KEYS.includes(key)) {
      refuse(`"${key}" is not editable from this desk.`);
    }
  }
  return serialise(async () => {
    const manifest = await readManifest(root);
    const record = manifest.agents.find((entry) => entry.id === id);
    if (!record) refuse("That isn't an agent on this station.");
    if (record.systemLocked) refuse("That identity's fields are fixed by the station.");
    if (record.lifecycle === "retired") refuse("A retired identity is a record, not a thing to edit.");

    const changed = [];
    if (fields.name !== undefined) {
      const name = plainText(fields.name, NAME_MAX, "A name");
      if (!name) refuse("An agent needs a name.");
      if (name !== record.name) {
        record.name = name;
        changed.push("name");
      }
    }
    if (fields.description !== undefined) {
      const description = fields.description === null
        ? ""
        : plainText(fields.description, DESCRIPTION_MAX, "A description");
      if (description !== record.description) {
        record.description = description;
        changed.push("description");
      }
    }
    if (fields.handle !== undefined) {
      const handle = String(fields.handle).toLowerCase().trim();
      if (!AGENT_HANDLE.test(handle)) {
        refuse(
          "A handle is two to thirty characters of lowercase letters, digits and hyphens, starting with a letter or digit.",
        );
      }
      if (handle !== record.handle) {
        assertHandleFree(manifest, handle, record.id);
        // The old handle is tombstoned in the same breath, per §5.4.
        manifest.tombstones.push({
          handle: record.handle,
          id: record.id,
          at: new Date().toISOString(),
          reason: "renamed",
        });
        record.handle = handle;
        record.path = `/agents/${handle}`;
        changed.push("handle");
      }
    }
    if (!changed.length) refuse("Nothing changed.");
    record.updatedAt = new Date().toISOString();
    assertCredentialFree(record);
    await writeProfile(root, record);
    // The standing orders quote the name and the purpose, so a rename that left
    // them stale would have the identity introduce itself as someone else.
    if (changed.includes("name") || changed.includes("description")) {
      record.policyRevision += 1;
      await writeStandingOrders(root, record);
    }
    await writeManifest(root, manifest);
    await audit(root, record.id, "updated", { changed });
    return sanitise(record);
  });
}

// ---------------------------------------------------------------------------
// §5.2 / §2.4 — activation is probed, never asserted
// ---------------------------------------------------------------------------
//
// The spec is emphatic that "configuration alone is not evidence": an identity
// becomes active only after probes run against the real thing. §2.4's probe list
// is written for a live container, and this milestone builds no container — so
// what runs here is the subset that is REAL for what M1 actually laid down, and
// the container half is reported by name as NOT YET RUN rather than quietly
// counted as passed. An operator reading this list should be able to see the
// difference between what was checked and what is still owed.

const CREDENTIAL_FILENAMES =
  /(^|\.)(env|netrc|npmrc|pem|key|p12|pfx|kdbx|jks|keystore)$|^(credentials?|token|secrets?|id_rsa|id_ed25519|\.git-credentials)$/i;

export const DEFERRED_PROBES = [
  "no direct network reachability from inside the container",
  "no credential store visible from inside the container",
  "no other identity's memory or transcript visible from inside the container",
  "writes succeed only to this identity's own memory",
  "standing orders and profile are unmodifiable from inside the container",
  "only explicitly approved typed sockets are visible",
];

async function walkFiles(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const full = join(dir, name);
    const info = await lstat(full).catch(() => null);
    if (!info) continue;
    if (info.isSymbolicLink()) {
      out.push({ full, name, info, symlink: true });
      continue;
    }
    if (info.isDirectory()) await walkFiles(full, out, depth + 1);
    else out.push({ full, name, info, symlink: false });
  }
  return out;
}

export async function probeAgent({ root, record }) {
  const dir = agentDir(root, record.id);
  const files = await walkFiles(dir);
  const checks = [];
  const add = (check, ok, detail) => checks.push({ check, ok, detail });

  let recordClean = true;
  let recordWhy = "the record carries no credential, capability or delegation";
  try {
    assertCredentialFree(record);
  } catch (error) {
    recordClean = false;
    recordWhy = error.message;
  }
  add("record is credential-free", recordClean, recordWhy);

  const credentialFile = files.find((file) => CREDENTIAL_FILENAMES.test(file.name));
  add(
    "no credential file anywhere in this identity's tree",
    !credentialFile,
    credentialFile ? `found ${credentialFile.name}` : "nothing credential-shaped on disk",
  );

  const link = files.find((file) => file.symlink);
  add(
    "no link out of this identity's own directory",
    !link,
    link ? `found a link at ${link.name}` : "every path under this identity is its own",
  );

  const orders = files.find((file) => file.name === "standing-orders.md");
  add(
    "standing orders are read-only",
    Boolean(orders) && (orders.info.mode & 0o222) === 0,
    orders ? `mode ${(orders.info.mode & 0o777).toString(8)}` : "no standing orders were laid down",
  );

  const profile = files.find((file) => file.name === "profile.json");
  add(
    "the identity cannot rewrite its own profile",
    Boolean(profile) && (profile.info.mode & 0o222) === 0,
    profile ? `mode ${(profile.info.mode & 0o777).toString(8)}` : "no profile was laid down",
  );

  const transcript = files.find((file) => file.name === "transcript.jsonl");
  add(
    "the transcript is written by the station, not the identity",
    !transcript || (transcript.info.mode & 0o077) === 0,
    transcript
      ? `mode ${(transcript.info.mode & 0o777).toString(8)}, owned by this service`
      : "no transcript yet",
  );

  add(
    "no sandbox, no network and no delegation to grant",
    record.runtimeProfile === null &&
      record.capabilityBindings.length === 0 &&
      record.delegationAllowlist.length === 0,
    "this identity holds nothing to probe a boundary against",
  );

  return { passed: checks.every((entry) => entry.ok), checks, deferred: DEFERRED_PROBES };
}

// §5.2's second half: activation, and only on a clean probe run.
export function activateAgent({ root, id }) {
  return serialise(async () => {
    const manifest = await readManifest(root);
    const record = manifest.agents.find((entry) => entry.id === id);
    if (!record) refuse("That isn't an agent on this station.");
    if (record.lifecycle === "retired") refuse("A retired identity is not activated again.");
    if (record.lifecycle === "active") refuse("That identity is already active.");
    const probe = await probeAgent({ root, record });
    if (!probe.passed) {
      const failed = probe.checks.filter((entry) => !entry.ok).map((entry) => entry.check);
      refuse(`Refused: ${failed.join("; ")}. Nothing was activated.`);
    }
    record.lifecycle = "active";
    record.updatedAt = new Date().toISOString();
    await writeProfile(root, record);
    await writeManifest(root, manifest);
    await audit(root, record.id, "activated", { checks: probe.checks.map((entry) => entry.check) });
    return { agent: sanitise(record), probe };
  });
}

// §4.4. Retirement is not deletion: routing stops, the handle stays reserved,
// and the record, transcript and audit history are kept. Suspension is the
// reversible half of the same idea.
export function setLifecycle({ root, id, lifecycle }) {
  if (!LIFECYCLES.has(lifecycle)) refuse("That isn't a lifecycle this station has.");
  if (lifecycle === "pending") refuse("An identity cannot be put back to pending.");
  return serialise(async () => {
    const manifest = await readManifest(root);
    const record = manifest.agents.find((entry) => entry.id === id);
    if (!record) refuse("That isn't an agent on this station.");
    if (record.systemLocked) refuse("That identity's lifecycle is fixed by the station.");
    if (record.lifecycle === "retired") refuse("That identity is already retired.");
    if (record.lifecycle === lifecycle) refuse("Nothing changed.");
    if (record.lifecycle === "pending" && lifecycle === "active") {
      // Activation is probed, never declared. This verb is for suspending and
      // resuming an identity that has already been through that gate.
      refuse("A pending identity is activated by running its probes, not by setting a word.");
    }
    record.lifecycle = lifecycle;
    record.updatedAt = new Date().toISOString();
    if (lifecycle === "retired") {
      manifest.tombstones.push({
        handle: record.handle,
        id: record.id,
        at: record.updatedAt,
        reason: "retired",
      });
    }
    await writeProfile(root, record);
    await writeManifest(root, manifest);
    await audit(root, record.id, "lifecycle", { lifecycle });
    return sanitise(record);
  });
}

// The permanent one, and deliberately the awkward one. §4.4 says retirement
// preserves; the operator still needs a way to actually remove an identity he
// created by mistake, so removal exists — but only after retirement, so it can
// never be the accidental outcome of a single click, and the handle stays
// reserved afterwards so the name cannot land on a different identity.
export function removeAgent({ root, id }) {
  return serialise(async () => {
    const manifest = await readManifest(root);
    const index = manifest.agents.findIndex((entry) => entry.id === id);
    if (index === -1) refuse("That isn't an agent on this station.");
    const record = manifest.agents[index];
    if (record.systemLocked) refuse("The station's own identities cannot be removed.");
    if (record.lifecycle !== "retired") {
      refuse("Retire the identity first. Removing is permanent and takes its transcript with it.");
    }
    manifest.agents.splice(index, 1);
    if (!manifest.tombstones.some((stone) => stone.handle === record.handle)) {
      manifest.tombstones.push({
        handle: record.handle,
        id: record.id,
        at: new Date().toISOString(),
        reason: "removed",
      });
    }
    await writeManifest(root, manifest);
    await rm(agentDir(root, id), { recursive: true, force: true });
    return { id, removed: true };
  });
}

// ---------------------------------------------------------------------------
// §4 — the canonical transcript
// ---------------------------------------------------------------------------
//
// The fixed desks keep their conversations in the browser and nowhere else; that
// is today's behaviour and migration §6 says it does not change. A NAMED agent
// is different by design: §4.1 gives it one canonical transcript owned and
// written by the station, so its thread survives a restart, a cleared browser
// and a different machine on the tailnet.
//
// The agent does not write this file. The station does, from what it saw go
// past — the same discipline the approval queue uses, and for the same reason:
// a record a model can author is a record a model can forge.

function transcriptPath(root, id) {
  return join(agentDir(root, id), "conversations", "transcript.jsonl");
}

export async function readTranscript({ root, id, limit = TRANSCRIPT_READ_MAX }) {
  let raw;
  try {
    raw = await readFile(transcriptPath(root, id), "utf8");
  } catch {
    return [];
  }
  const turns = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const role = parsed?.role === "assistant" ? "assistant" : parsed?.role === "user" ? "user" : null;
    if (!role || typeof parsed?.content !== "string") continue;
    turns.push({ role, content: parsed.content, at: typeof parsed.at === "string" ? parsed.at : null });
  }
  return turns.slice(-Math.max(1, Math.min(limit, TRANSCRIPT_READ_MAX)));
}

export function appendTurns({ root, id, turns }) {
  const clean = (Array.isArray(turns) ? turns : [])
    .map((turn) => ({
      at: new Date().toISOString(),
      role: turn?.role === "assistant" ? "assistant" : turn?.role === "user" ? "user" : null,
      content: typeof turn?.content === "string" ? turn.content.slice(0, TURN_MAX_CHARS) : null,
    }))
    .filter((turn) => turn.role && turn.content);
  if (!clean.length) return Promise.resolve(0);
  return serialise(async () => {
    const file = transcriptPath(root, id);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await appendFile(file, clean.map((turn) => JSON.stringify(turn)).join("\n") + "\n", {
      mode: 0o600,
    });
    const info = await stat(file).catch(() => null);
    if (info && info.size > TRANSCRIPT_MAX_BYTES) {
      // Rewrite rather than grow without bound. The oldest turns go, which is a
      // nuisance; an unbounded file on the operator's own disk is worse.
      const kept = await readTranscript({ root, id, limit: TRANSCRIPT_KEEP_TURNS });
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, kept.map((turn) => JSON.stringify(turn)).join("\n") + "\n", {
        mode: 0o600,
      });
      await rename(tmp, file);
    }
    return clean.length;
  });
}

export const LIMITS = {
  NAME_MAX,
  DESCRIPTION_MAX,
  AGENTS_MAX,
  TRANSCRIPT_READ_MAX,
};
