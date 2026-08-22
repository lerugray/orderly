#!/usr/bin/env node
// Host-local connector control. It accepts only the fixed actions below and
// never accepts provider keys or account tokens.

import { isAbsolute } from "node:path";

import {
  connectorControlView,
  ConnectorRefused,
  registerConnectorInstance,
  transitionAttachment,
} from "./control.mjs";
import { connectorCatalogView } from "./catalog.mjs";
import { probeAndActivateAttachment, probeAndActivateInstance } from "./probes.mjs";

const action = process.argv[2];
const stateAt = process.argv.indexOf("--state");
const statePath = stateAt >= 0 ? process.argv[stateAt + 1] : null;
const probeAt = process.argv.indexOf("--probe-program");
const probeProgram = probeAt >= 0 ? process.argv[probeAt + 1] : null;
const actions = new Set(["catalog", "list", "register", "activate-instance", "activate-attachment", "resume", "suspend", "detach"]);

if (!actions.has(action) || (action !== "catalog" && (!statePath || !isAbsolute(statePath)))) {
  process.stderr.write("usage: node connectorctl.mjs <catalog|list|register|activate-instance|activate-attachment|resume|suspend|detach> --state /absolute/connectors.json [--probe-program /absolute/program]\n");
  process.exitCode = 2;
} else {
  try {
    let result;
    if (action === "catalog") result = connectorCatalogView();
    else if (action === "list") result = await connectorControlView({ statePath });
    else {
      const chunks = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > 64 * 1024) throw new ConnectorRefused("The control request is too large.");
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
        throw new ConnectorRefused("The control request is not valid JSON.");
      }
      const allowed = action === "register"
        ? ["id", "kind", "label", "accountLabel", "operations"]
        : action === "activate-instance"
          ? ["connectorId", "probeRevision"]
          : action === "activate-attachment" || action === "resume"
            ? ["attachmentId", "probeRevision"]
            : ["attachmentId", "routeRemoved"];
      for (const key of Object.keys(body ?? {})) {
        if (!allowed.includes(key)) throw new ConnectorRefused(`"${key}" is not part of connector control action "${action}".`);
      }
      if (action === "register") result = await registerConnectorInstance({ statePath, fields: body });
      if (action === "activate-instance") {
        result = await probeAndActivateInstance({ statePath, ...body, program: probeProgram });
      }
      if (action === "activate-attachment" || action === "resume") {
        result = await probeAndActivateAttachment({ statePath, ...body, program: probeProgram });
      }
      if (action === "suspend" || action === "detach") {
        result = await transitionAttachment({
          statePath,
          attachmentId: body?.attachmentId,
          lifecycle: action === "suspend" ? "suspended" : "detached",
          routeRemoved: body?.routeRemoved,
        });
      }
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof ConnectorRefused ? error.message : "Connector control failed."}\n`);
    process.exitCode = error instanceof ConnectorRefused ? 2 : 1;
  }
}
