import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { activateConnectorInstance, INSTANCE_PROBES, registerConnectorInstance } from "../control.mjs";

test("Agents connector endpoint prepares and records the reviewed attachment", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orderly-connectors-web-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, "connectors.json");
  const configPath = join(dir, "openclaw.json");
  await writeFile(configPath, JSON.stringify({
    agents: {
      defaults: { sandbox: { mode: "all" }, model: { primary: "p/m", fallbacks: [] } },
      list: [{ id: "coordinator", tools: {}, sandbox: {} }],
    },
    models: { providers: { p: { models: [{ id: "m", name: "M" }] } } },
    tools: { elevated: { enabled: false } },
  }));
  await registerConnectorInstance({
    statePath,
    fields: {
      id: "drive-personal", kind: "google-drive", label: "Personal Drive",
      accountLabel: "Personal workspace", operations: ["files.read"],
    },
  });
  await activateConnectorInstance({
    statePath, connectorId: "drive-personal", probeRevision: "deploy-1",
    results: Object.fromEntries(INSTANCE_PROBES.map((name) => [name, true])),
  });

  process.env.ORDERLY_CONFIG = configPath;
  process.env.ORDERLY_CONNECTORS_CONFIG = statePath;
  process.env.ORDERLY_REPLY_STYLE_CONFIG = join(dir, "reply-style.json");
  process.env.ORDERLY_AGENTS_ROOT = join(dir, "agents");
  const { dispatchWebRequest } = await import(`../../web/server.mjs?connector-flow=${Date.now()}`);
  const post = async (body) => {
    const response = await dispatchWebRequest({
      url: "/api/connectors", method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { response, body: response.json() };
  };
  const proposed = await post({
    action: "propose", connectorId: "drive-personal", agentId: "coordinator", operations: ["files.read"],
  });
  assert.equal(proposed.response.status, 200, JSON.stringify(proposed.body));
  const confirmed = await post({
    action: "confirm", connectorId: "drive-personal", agentId: "coordinator",
    operations: ["files.read"], confirmationDigest: proposed.body.digest,
  });
  assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.attachment.lifecycle, "approved-pending-runtime");
  const stored = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(stored.attachments.length, 1);
  assert.equal(stored.attachments[0].agentId, "coordinator");

  const extra = await post({ action: "propose", connectorId: "drive-personal", agentId: "coordinator", operations: ["files.read"], endpoint: "https://example.test" });
  assert.equal(extra.response.status, 400);
  assert.match(extra.body.error, /endpoint/);
});
