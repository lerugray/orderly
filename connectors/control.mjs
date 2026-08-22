import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { catalogKind, connectorCatalogView } from "./catalog.mjs";

const CONNECTOR_ID = /^[a-z][a-z0-9-]{2,47}$/;
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const OPERATION_ID = /^[a-z][a-z0-9.-]{2,79}$/;
const LIFECYCLES = new Set(["pending", "active", "suspended", "retired"]);
const ATTACHMENT_LIFECYCLES = new Set(["approved-pending-runtime", "active", "suspended", "detached"]);
const PROBE_REVISION = /^[A-Za-z0-9._:-]{1,80}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const INSTANCE_PROBES = Object.freeze([
  "service-active",
  "socket-owner-mode",
  "credential-scope",
  "egress-allowlist",
  "unrelated-agents-denied",
  "web-denied",
  "broker-denied",
  "fixed-agents-denied",
]);
const ATTACHMENT_PROBES = Object.freeze([
  "designated-socket-mounted",
  "credential-store-absent",
  "unrelated-socket-denied",
  "operation-allowlist-enforced",
]);

const EMPTY = Object.freeze({ v: 1, revision: 0, instances: [], attachments: [], tombstones: [], events: [] });
const isObj = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export class ConnectorRefused extends Error {}
const refuse = (message) => {
  throw new ConnectorRefused(message);
};

function exactKeys(value, allowed, what) {
  if (!isObj(value)) refuse(`Malformed ${what}.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) refuse(`"${key}" is not part of ${what}.`);
  }
}

function plainLabel(value, what, max = 120) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    refuse(`${what} must be one short plain-text label.`);
  }
  return value.trim();
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObj(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function derivedService(instanceId) {
  return {
    unit: `orderly-connector-${instanceId}.service`,
    socket: `/var/lib/orderly-connectors/${instanceId}/connector.sock`,
  };
}

function operationMap(instance) {
  const kind = catalogKind(instance.kind);
  return new Map((kind?.operations ?? []).map((operation) => [operation.id, operation]));
}

function checkedOperations(instance, requested, { agentVisible = false } = {}) {
  if (!Array.isArray(requested) || !requested.length) refuse("At least one connector operation must be named.");
  if (new Set(requested).size !== requested.length) refuse("The same connector operation is listed twice.");
  const compiled = operationMap(instance);
  const installed = new Set(instance.operations);
  for (const id of requested) {
    if (typeof id !== "string" || !OPERATION_ID.test(id) || !compiled.has(id) || !installed.has(id)) {
      refuse(`Connector "${instance.id}" does not have operation "${String(id)}" installed.`);
    }
    if (agentVisible && compiled.get(id).mode === "apply") {
      refuse(`Apply operation "${id}" can never be attached to an agent.`);
    }
  }
  return [...requested].sort();
}

function assertState(state) {
  exactKeys(state, ["v", "revision", "instances", "attachments", "tombstones", "events"], "connector control state");
  if (state.v !== 1 || !Number.isInteger(state.revision) || state.revision < 0) refuse("Unsupported connector control state.");
  if (!Array.isArray(state.instances) || !Array.isArray(state.attachments) || !Array.isArray(state.tombstones) || !Array.isArray(state.events)) {
    refuse("Malformed connector control collections.");
  }
  const ids = new Set();
  for (const instance of state.instances) {
    exactKeys(instance, ["id", "kind", "label", "accountLabel", "operations", "lifecycle", "service", "probeRevision", "createdAt", "updatedAt"], "connector instance");
    if (!CONNECTOR_ID.test(instance.id) || ids.has(instance.id)) refuse("Connector identifiers must be unique and derived-safe.");
    ids.add(instance.id);
    const compiled = catalogKind(instance.kind);
    if (!compiled) refuse(`Unknown connector kind "${instance.kind}".`);
    plainLabel(instance.label, "Connector label");
    plainLabel(instance.accountLabel, "Connector account label");
    if (!LIFECYCLES.has(instance.lifecycle)) refuse(`Unknown lifecycle for connector "${instance.id}".`);
    const expected = derivedService(instance.id);
    if (JSON.stringify(instance.service) !== JSON.stringify(expected)) refuse(`Connector "${instance.id}" has a non-derived service route.`);
    checkedOperations(instance, instance.operations);
    if (instance.probeRevision !== null && (typeof instance.probeRevision !== "string" || !PROBE_REVISION.test(instance.probeRevision))) {
      refuse(`Connector "${instance.id}" has a malformed probe revision.`);
    }
  }
  if (new Set(state.tombstones).size !== state.tombstones.length) refuse("Connector tombstones must be unique.");
  for (const id of state.tombstones) {
    if (typeof id !== "string" || !CONNECTOR_ID.test(id) || ids.has(id)) refuse("Connector tombstones must be reserved connector identifiers.");
  }
  const attachmentIds = new Set();
  const attachmentOwners = new Set();
  for (const attachment of state.attachments) {
    exactKeys(attachment, ["id", "connectorId", "agentId", "operations", "lifecycle", "confirmationDigest", "probeRevision", "createdAt", "updatedAt"], "connector attachment");
    if (typeof attachment.id !== "string" || !/^att-[a-f0-9-]{20,}$/.test(attachment.id) || attachmentIds.has(attachment.id)) refuse("Attachment identifiers must be unique.");
    attachmentIds.add(attachment.id);
    if (!AGENT_ID.test(attachment.agentId)) refuse("Malformed attachment agent identifier.");
    if (!ATTACHMENT_LIFECYCLES.has(attachment.lifecycle)) refuse("Unknown attachment lifecycle.");
    if (typeof attachment.confirmationDigest !== "string" || !DIGEST.test(attachment.confirmationDigest)) refuse("Malformed attachment confirmation digest.");
    if (attachment.probeRevision !== null && (typeof attachment.probeRevision !== "string" || !PROBE_REVISION.test(attachment.probeRevision))) {
      refuse("Malformed attachment probe revision.");
    }
    const instance = state.instances.find((item) => item.id === attachment.connectorId);
    if (!instance) refuse(`Attachment ${attachment.id} names a missing connector.`);
    checkedOperations(instance, attachment.operations, { agentVisible: true });
    if (attachment.lifecycle !== "detached") {
      if (attachmentOwners.has(attachment.connectorId)) refuse(`Connector "${attachment.connectorId}" has more than one attachment owner.`);
      attachmentOwners.add(attachment.connectorId);
    }
  }
  if (state.events.length > 1000 || state.events.some((event) => !isObj(event))) refuse("Malformed connector event history.");
  return state;
}

export async function readConnectorState(statePath) {
  let raw;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return structuredClone(EMPTY);
    throw error;
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    refuse("The connector control record is not valid JSON. Nothing was changed.");
  }
  return assertState(state);
}

async function pruneBackups(statePath, keep = 10) {
  const dir = dirname(statePath);
  const prefix = `${basename(statePath)}.orderly-bak-`;
  try {
    const files = (await readdir(dir)).filter((name) => name.startsWith(prefix)).sort();
    for (const file of files.slice(0, Math.max(0, files.length - keep))) await unlink(join(dir, file)).catch(() => {});
  } catch {
    // Backup pruning never weakens the write itself.
  }
}

let writes = Promise.resolve();
function serialise(work) {
  const next = writes.then(work, work);
  writes = next.then(() => undefined, () => undefined);
  return next;
}

async function withStateLock(statePath, work) {
  const lockPath = `${statePath}.lock`;
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") refuse("Another connector control write is in progress. Try again after it finishes.");
    throw error;
  }
  try {
    return await work();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

async function persist(statePath, state, event) {
  return serialise(async () => {
    const dir = dirname(statePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return withStateLock(statePath, async () => {
      const current = await readConnectorState(statePath);
      if (current.revision !== state.revision) refuse("Connector state changed while this ruling was being prepared. Review it again.");
      const next = structuredClone(state);
      next.revision += 1;
      next.events.push({ at: new Date().toISOString(), ...event });
      next.events = next.events.slice(-1000);
      assertState(next);
      try {
        await stat(statePath);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await copyFile(statePath, `${statePath}.orderly-bak-${stamp}`);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const tmp = join(dir, `.${basename(statePath)}.tmp-${process.pid}-${Date.now()}`);
      const body = `${JSON.stringify(next, null, 2)}\n`;
      await writeFile(tmp, body, { mode: 0o600 });
      const handle = await open(tmp, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
      await rename(tmp, statePath);
      await pruneBackups(statePath);
      return next;
    });
  });
}

// Host-local provisioning API. The web server intentionally does not expose it.
export async function registerConnectorInstance({ statePath, fields }) {
  exactKeys(fields, ["id", "kind", "label", "accountLabel", "operations"], "connector registration");
  if (!CONNECTOR_ID.test(fields.id)) refuse("A connector id uses lowercase letters, digits, and dashes.");
  const kind = catalogKind(fields.kind);
  if (!kind) refuse(`Unknown connector kind "${fields.kind}".`);
  const state = await readConnectorState(statePath);
  if (state.instances.some((instance) => instance.id === fields.id) || state.tombstones.includes(fields.id)) {
    refuse(`Connector id "${fields.id}" is already used or reserved.`);
  }
  const candidate = {
    id: fields.id,
    kind: fields.kind,
    label: plainLabel(fields.label, "Connector label"),
    accountLabel: plainLabel(fields.accountLabel, "Connector account label"),
    operations: [],
    lifecycle: "pending",
    service: derivedService(fields.id),
    probeRevision: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  candidate.operations = checkedOperations({ ...candidate, operations: kind.operations.map((operation) => operation.id) }, fields.operations);
  state.instances.push(candidate);
  const saved = await persist(statePath, state, { event: "connector.registered", connectorId: candidate.id });
  return sanitiseInstance(saved.instances.find((instance) => instance.id === candidate.id));
}

function requireProbes(results, required, what) {
  exactKeys(results, required, `${what} probe result`);
  for (const name of required) {
    if (results[name] !== true) refuse(`${what} probe "${name}" has not passed.`);
  }
}

export async function activateConnectorInstance({ statePath, connectorId, probeRevision, results }) {
  if (typeof probeRevision !== "string" || !PROBE_REVISION.test(probeRevision)) refuse("A probe revision must identify the checked deployment.");
  requireProbes(results, INSTANCE_PROBES, "Connector activation");
  const state = await readConnectorState(statePath);
  const instance = state.instances.find((item) => item.id === connectorId);
  if (!instance || instance.lifecycle === "retired") refuse("That connector cannot be activated.");
  if (!(catalogKind(instance.kind)?.egressHosts.length)) refuse("That connector kind has no compiled provider endpoint allowlist and cannot be activated.");
  instance.lifecycle = "active";
  instance.probeRevision = probeRevision;
  instance.updatedAt = new Date().toISOString();
  const saved = await persist(statePath, state, { event: "connector.activated", connectorId, probeRevision });
  return sanitiseInstance(saved.instances.find((item) => item.id === connectorId));
}

function sanitiseInstance(instance) {
  const compiled = operationMap(instance);
  const kind = catalogKind(instance.kind);
  return {
    id: instance.id,
    kind: instance.kind,
    label: instance.label,
    accountLabel: instance.accountLabel,
    lifecycle: instance.lifecycle,
    probeRevision: instance.probeRevision,
    egressHosts: [...(kind?.egressHosts ?? [])],
    operations: instance.operations.map((id) => ({ ...compiled.get(id) })),
  };
}

function sanitiseAttachment(attachment) {
  return {
    id: attachment.id,
    connectorId: attachment.connectorId,
    agentId: attachment.agentId,
    operations: [...attachment.operations],
    lifecycle: attachment.lifecycle,
    probeRevision: attachment.probeRevision,
    createdAt: attachment.createdAt,
    updatedAt: attachment.updatedAt,
  };
}

export async function connectorControlView({ statePath }) {
  const state = await readConnectorState(statePath);
  return {
    state: "ok",
    revision: state.revision,
    catalog: connectorCatalogView(),
    instances: state.instances.map(sanitiseInstance),
    attachments: state.attachments.map(sanitiseAttachment),
    readAt: new Date().toISOString(),
  };
}

function attachmentProposal(state, instance, agent, operations) {
  const kind = catalogKind(instance.kind);
  const proposal = {
    v: 1,
    stateRevision: state.revision,
    connectorId: instance.id,
    connectorKind: instance.kind,
    connectorLabel: instance.label,
    accountLabel: instance.accountLabel,
    connectorProbeRevision: instance.probeRevision,
    providerEndpoints: [...(kind?.egressHosts ?? [])],
    agentId: agent.id,
    agentName: agent.name,
    agentLifecycle: agent.lifecycle,
    memoryPolicy: agent.memoryPolicy,
    operations: checkedOperations(instance, operations, { agentVisible: true }),
  };
  const compiled = operationMap(instance);
  return {
    proposal,
    digest: digest(proposal),
    summary: {
      agent: { id: agent.id, name: agent.name, memoryPolicy: agent.memoryPolicy },
      connector: sanitiseInstance(instance),
      operations: proposal.operations.map((id) => ({ ...compiled.get(id) })),
      returnedData: agent.memoryPolicy === "persistent"
        ? "Results enter a persistent transcript and may be summarized into this agent's memory."
        : "Results enter this conversation only; the connector cannot write memory.",
      boundary: "The credential remains in its dedicated host service; the agent receives only the approved typed socket operations after runtime probes pass.",
    },
  };
}

function checkedAgent(agent) {
  exactKeys(agent, ["id", "name", "lifecycle", "memoryPolicy"], "attachment agent projection");
  if (!AGENT_ID.test(agent.id)) refuse("Malformed attachment agent identifier.");
  plainLabel(agent.name, "Agent name", 80);
  if (agent.lifecycle !== "active") refuse(`Agent "${agent.id}" must be active before a connector can be attached.`);
  if (agent.memoryPolicy !== "persistent" && agent.memoryPolicy !== "memoryless") refuse("Unknown agent memory policy.");
  return agent;
}

export async function proposeAttachment({ statePath, connectorId, agent, operations }) {
  checkedAgent(agent);
  const state = await readConnectorState(statePath);
  const instance = state.instances.find((item) => item.id === connectorId);
  if (!instance || instance.lifecycle !== "active") refuse("That connector is not active and probe-qualified.");
  const owner = state.attachments.find((item) => item.connectorId === connectorId && item.lifecycle !== "detached");
  if (owner && owner.agentId !== agent.id) refuse(`Connector "${connectorId}" is already ruled to another agent.`);
  if (owner) refuse(`Connector "${connectorId}" already has an attachment ruling.`);
  return attachmentProposal(state, instance, agent, operations);
}

export async function confirmAttachment({ statePath, connectorId, agent, operations, confirmationDigest }) {
  checkedAgent(agent);
  const state = await readConnectorState(statePath);
  const instance = state.instances.find((item) => item.id === connectorId);
  if (!instance || instance.lifecycle !== "active") refuse("That connector is not active and probe-qualified.");
  if (state.attachments.some((item) => item.connectorId === connectorId && item.lifecycle !== "detached")) {
    refuse(`Connector "${connectorId}" already has an attachment ruling.`);
  }
  const prepared = attachmentProposal(state, instance, agent, operations);
  if (typeof confirmationDigest !== "string" || confirmationDigest !== prepared.digest) {
    refuse("That connector ruling is stale or does not match what was reviewed.");
  }
  const now = new Date().toISOString();
  const attachment = {
    id: `att-${randomUUID()}`,
    connectorId,
    agentId: agent.id,
    operations: prepared.proposal.operations,
    lifecycle: "approved-pending-runtime",
    confirmationDigest,
    probeRevision: null,
    createdAt: now,
    updatedAt: now,
  };
  state.attachments.push(attachment);
  const saved = await persist(statePath, state, { event: "attachment.approved", connectorId, agentId: agent.id });
  return {
    attachment: sanitiseAttachment(saved.attachments.find((item) => item.id === attachment.id)),
    note: "Approved, but not active. The derived socket mount and negative-access probes must pass on the host first.",
  };
}

// Host runtime transition. It is intentionally not exposed by orderly-web.
export async function activateAttachment({ statePath, attachmentId, probeRevision, results }) {
  requireProbes(results, ATTACHMENT_PROBES, "Attachment activation");
  if (typeof probeRevision !== "string" || !PROBE_REVISION.test(probeRevision)) refuse("A probe revision must identify the checked runtime.");
  const state = await readConnectorState(statePath);
  const attachment = state.attachments.find((item) => item.id === attachmentId);
  if (!attachment || !["approved-pending-runtime", "suspended"].includes(attachment.lifecycle)) refuse("That attachment is not waiting for runtime activation or resume.");
  const instance = state.instances.find((item) => item.id === attachment.connectorId);
  if (!instance || instance.lifecycle !== "active") refuse("The connector instance is not active.");
  const wasSuspended = attachment.lifecycle === "suspended";
  attachment.lifecycle = "active";
  attachment.probeRevision = probeRevision;
  attachment.updatedAt = new Date().toISOString();
  const saved = await persist(statePath, state, {
    event: wasSuspended ? "attachment.resumed" : "attachment.activated",
    attachmentId,
    probeRevision,
  });
  return sanitiseAttachment(saved.attachments.find((item) => item.id === attachmentId));
}

export async function transitionAttachment({ statePath, attachmentId, lifecycle, routeRemoved }) {
  if (!["suspended", "detached"].includes(lifecycle)) refuse("Only suspend and detach are host runtime transitions here.");
  if (routeRemoved !== true) refuse("The runtime route must be removed and checked before state can say this attachment is inactive.");
  const state = await readConnectorState(statePath);
  const attachment = state.attachments.find((item) => item.id === attachmentId);
  if (!attachment || attachment.lifecycle === "detached") refuse("That attachment is not active on this station.");
  attachment.lifecycle = lifecycle;
  attachment.updatedAt = new Date().toISOString();
  const saved = await persist(statePath, state, { event: `attachment.${lifecycle}`, attachmentId });
  return sanitiseAttachment(saved.attachments.find((item) => item.id === attachmentId));
}

export { ATTACHMENT_PROBES, INSTANCE_PROBES };
