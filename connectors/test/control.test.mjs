import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { connectorCatalogView } from "../catalog.mjs";
import {
  activateAttachment,
  activateConnectorInstance,
  ATTACHMENT_PROBES,
  confirmAttachment,
  connectorControlView,
  ConnectorRefused,
  INSTANCE_PROBES,
  proposeAttachment,
  readConnectorState,
  registerConnectorInstance,
  transitionAttachment,
} from "../control.mjs";
import { probeAndActivateInstance } from "../probes.mjs";
import { createConnectorRuntimeHandler, dispatchRuntimeRequest } from "../runtime.mjs";

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), "orderly-connectors-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "connectors.json");
}

const passed = (names) => Object.fromEntries(names.map((name) => [name, true]));
const agent = { id: "coordinator", name: "Coordinator", lifecycle: "active", memoryPolicy: "persistent" };

async function activeDrive(t) {
  const statePath = await scratch(t);
  await registerConnectorInstance({
    statePath,
    fields: {
      id: "drive-ray",
      kind: "google-drive",
      label: "Drive",
      accountLabel: "Personal workspace",
      operations: ["files.list", "files.read"],
    },
  });
  await activateConnectorInstance({
    statePath,
    connectorId: "drive-ray",
    probeRevision: "deploy-1",
    results: passed(INSTANCE_PROBES),
  });
  return statePath;
}

test("catalog keeps service families separately reviewable", () => {
  const ids = new Set(connectorCatalogView().map((entry) => entry.id));
  for (const id of ["google-drive", "google-docs", "google-sheets", "google-tasks", "google-people"]) {
    assert.ok(ids.has(id), id);
  }
  assert.equal(ids.has("google-workspace"), false);
  for (const id of [
    "microsoft-outlook-mail", "microsoft-calendar-read", "microsoft-calendar-write",
    "microsoft-onedrive", "microsoft-sharepoint", "microsoft-excel", "microsoft-todo",
    "microsoft-teams",
  ]) assert.ok(ids.has(id), id);
  assert.equal(ids.has("microsoft-365"), false);
  for (const id of ["github", "slack", "discord", "linkedin", "imap-mail"]) assert.ok(ids.has(id), id);
});

test("reading a station with no connector state creates nothing", async (t) => {
  const statePath = await scratch(t);
  assert.deepEqual(await readConnectorState(statePath), {
    v: 1, revision: 0, instances: [], attachments: [], tombstones: [], events: [],
  });
  await assert.rejects(stat(statePath), { code: "ENOENT" });
});

test("host registration is typed, derived, and pending until every probe passes", async (t) => {
  const statePath = await scratch(t);
  await assert.rejects(
    registerConnectorInstance({ statePath, fields: { id: "drive-ray", kind: "google-drive", label: "Drive", accountLabel: "Personal", operations: ["files.read"], token: "no" } }),
    /token/,
  );
  const instance = await registerConnectorInstance({
    statePath,
    fields: { id: "drive-ray", kind: "google-drive", label: "Drive", accountLabel: "Personal", operations: ["files.read"] },
  });
  assert.equal(instance.lifecycle, "pending");
  assert.equal(JSON.stringify(instance).includes("/var/lib"), false);
  await assert.rejects(
    activateConnectorInstance({ statePath, connectorId: "drive-ray", probeRevision: "deploy-1", results: { ...passed(INSTANCE_PROBES), "web-denied": false } }),
    /web-denied/,
  );
  const active = await activateConnectorInstance({
    statePath, connectorId: "drive-ray", probeRevision: "deploy-1", results: passed(INSTANCE_PROBES),
  });
  assert.equal(active.lifecycle, "active");
  assert.equal((await stat(statePath)).mode & 0o077, 0);
});

test("attachment confirmation is digest-bound and remains inactive until runtime checks", async (t) => {
  const statePath = await activeDrive(t);
  const proposed = await proposeAttachment({ statePath, connectorId: "drive-ray", agent, operations: ["files.read"] });
  assert.match(proposed.digest, /^[a-f0-9]{64}$/);
  assert.match(proposed.summary.returnedData, /persistent transcript/);
  assert.deepEqual(proposed.summary.connector.egressHosts, ["www.googleapis.com", "oauth2.googleapis.com"]);
  assert.deepEqual(proposed.proposal.providerEndpoints, proposed.summary.connector.egressHosts);
  await assert.rejects(
    confirmAttachment({ statePath, connectorId: "drive-ray", agent, operations: ["files.list"], confirmationDigest: proposed.digest }),
    /stale|match/,
  );
  const confirmed = await confirmAttachment({
    statePath, connectorId: "drive-ray", agent, operations: ["files.read"], confirmationDigest: proposed.digest,
  });
  assert.equal(confirmed.attachment.lifecycle, "approved-pending-runtime");
  assert.match(confirmed.note, /not active/i);
  await assert.rejects(
    activateAttachment({ statePath, attachmentId: confirmed.attachment.id, probeRevision: "mount-1", results: { ...passed(ATTACHMENT_PROBES), "credential-store-absent": false } }),
    /credential-store-absent/,
  );
  const active = await activateAttachment({
    statePath, attachmentId: confirmed.attachment.id, probeRevision: "mount-1", results: passed(ATTACHMENT_PROBES),
  });
  assert.equal(active.lifecycle, "active");
  const suspended = await transitionAttachment({ statePath, attachmentId: active.id, lifecycle: "suspended", routeRemoved: true });
  assert.equal(suspended.lifecycle, "suspended");
  const resumed = await activateAttachment({
    statePath, attachmentId: active.id, probeRevision: "mount-2", results: passed(ATTACHMENT_PROBES),
  });
  assert.equal(resumed.lifecycle, "active");
});

test("one connector instance has one attachment owner and apply operations stay host-side", async (t) => {
  const statePath = await scratch(t);
  await registerConnectorInstance({
    statePath,
    fields: {
      id: "calendar-write-ray", kind: "google-calendar-write", label: "Calendar writes",
      accountLabel: "Personal calendar", operations: ["events.create.propose", "events.create.apply"],
    },
  });
  await activateConnectorInstance({
    statePath, connectorId: "calendar-write-ray", probeRevision: "deploy-1", results: passed(INSTANCE_PROBES),
  });
  await assert.rejects(
    proposeAttachment({ statePath, connectorId: "calendar-write-ray", agent, operations: ["events.create.apply"] }),
    /never be attached/,
  );
  const proposal = await proposeAttachment({
    statePath, connectorId: "calendar-write-ray", agent, operations: ["events.create.propose"],
  });
  await confirmAttachment({
    statePath, connectorId: "calendar-write-ray", agent, operations: ["events.create.propose"], confirmationDigest: proposal.digest,
  });
  const other = { id: "researcher", name: "Researcher", lifecycle: "active", memoryPolicy: "memoryless" };
  await assert.rejects(
    proposeAttachment({ statePath, connectorId: "calendar-write-ray", agent: other, operations: ["events.create.propose"] }),
    /another agent|already ruled/,
  );
  const view = await connectorControlView({ statePath });
  assert.equal(JSON.stringify(view).includes("connector.sock"), false);
});

test("unknown state fields fail closed", async () => {
  await assert.rejects(
    registerConnectorInstance({ statePath: "/dev/null", fields: { id: "x" } }),
    ConnectorRefused,
  );
});

test("loaded state enforces one owner and writes refuse a cross-process lock", async (t) => {
  const statePath = await activeDrive(t);
  const proposed = await proposeAttachment({ statePath, connectorId: "drive-ray", agent, operations: ["files.read"] });
  await confirmAttachment({
    statePath, connectorId: "drive-ray", agent, operations: ["files.read"], confirmationDigest: proposed.digest,
  });
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.attachments.push({ ...state.attachments[0], id: `att-${"a".repeat(32)}`, agentId: "researcher" });
  await writeFile(statePath, `${JSON.stringify(state)}\n`);
  await assert.rejects(readConnectorState(statePath), /more than one attachment owner/);

  const secondPath = await scratch(t);
  await writeFile(`${secondPath}.lock`, "held\n", { mode: 0o600 });
  await assert.rejects(registerConnectorInstance({
    statePath: secondPath,
    fields: { id: "drive-locked", kind: "google-drive", label: "Drive", accountLabel: "Locked", operations: ["files.read"] },
  }), /write is in progress/);
});

test("a catalog kind without a compiled endpoint allowlist cannot be activated", async (t) => {
  const statePath = await scratch(t);
  await registerConnectorInstance({
    statePath,
    fields: { id: "imap-local", kind: "imap-mail", label: "IMAP", accountLabel: "Mail", operations: ["messages.read"] },
  });
  await assert.rejects(activateConnectorInstance({
    statePath, connectorId: "imap-local", probeRevision: "deploy-1", results: passed(INSTANCE_PROBES),
  }), /endpoint allowlist/);
});

test("host activation obtains every compiled probe result from the fixed runner", async (t) => {
  const statePath = await scratch(t);
  await registerConnectorInstance({
    statePath,
    fields: { id: "drive-probed", kind: "google-drive", label: "Drive", accountLabel: "Probe account", operations: ["files.read"] },
  });
  const seen = [];
  const active = await probeAndActivateInstance({
    statePath,
    connectorId: "drive-probed",
    probeRevision: "runtime-build-7",
    program: "/host/fixed-probe",
    run: async (request) => { seen.push(request); return true; },
  });
  assert.equal(active.lifecycle, "active");
  assert.deepEqual(seen.map((request) => request.check), INSTANCE_PROBES);
  assert.ok(seen.every((request) => request.program === "/host/fixed-probe" && request.subjectId === "drive-probed"));
});

test("desk lifecycle changes are route-first and resume is probe-gated", async (t) => {
  const statePath = await activeDrive(t);
  const proposed = await proposeAttachment({ statePath, connectorId: "drive-ray", agent, operations: ["files.read"] });
  const confirmed = await confirmAttachment({
    statePath, connectorId: "drive-ray", agent, operations: ["files.read"], confirmationDigest: proposed.digest,
  });
  await activateAttachment({
    statePath, attachmentId: confirmed.attachment.id, probeRevision: "mount-1", results: passed(ATTACHMENT_PROBES),
  });
  const actions = [];
  const handler = createConnectorRuntimeHandler({
    statePath,
    route: {
      remove: async ({ action }) => { actions.push(`remove:${action}`); return true; },
      install: async ({ action }) => { actions.push(`install:${action}`); return true; },
    },
    probes: async ({ check }) => { actions.push(`probe:${check}`); return true; },
    probeRevision: async () => "mount-2",
  });
  const suspended = await dispatchRuntimeRequest({
    handler, body: { v: 1, action: "suspend", attachmentId: confirmed.attachment.id },
  });
  assert.equal(suspended.status, 200);
  assert.equal(suspended.body.attachment.lifecycle, "suspended");
  const resumed = await dispatchRuntimeRequest({
    handler, body: { v: 1, action: "resume", attachmentId: confirmed.attachment.id },
  });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.attachment.lifecycle, "active");
  assert.deepEqual(actions, ["remove:suspend", "install:resume", ...ATTACHMENT_PROBES.map((check) => `probe:${check}`)]);
});
