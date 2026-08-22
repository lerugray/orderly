// Fixed host probe runner. Activation callers name only a connector/attachment
// already present in the control record and a host-installed absolute program.
// The program receives a fixed argv and returns one small JSON evidence record
// per compiled check; no caller-supplied boolean can activate anything.

import { spawn } from "node:child_process";

import {
  activateAttachment,
  activateConnectorInstance,
  ATTACHMENT_PROBES,
  INSTANCE_PROBES,
} from "./control.mjs";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const MAX_OUTPUT = 32 * 1024;

export class ConnectorProbeRefused extends Error {}
const refuse = (message) => { throw new ConnectorProbeRefused(message); };

function checkedProgram(program) {
  if (typeof program !== "string" || !program.startsWith("/") || /[\u0000-\u001f\u007f]/.test(program)) {
    refuse("Connector probe program must be a host-installed absolute path.");
  }
  return program;
}

export function runProbeProgram({ program, scope, subjectId, check, probeRevision, timeoutMs = 30_000 }) {
  checkedProgram(program);
  if (scope !== "instance" && scope !== "attachment") refuse("Unknown connector probe scope.");
  if (!SAFE_ID.test(subjectId) || !SAFE_ID.test(check) || !SAFE_ID.test(probeRevision)) refuse("Malformed connector probe identifier.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) refuse("Connector probe timeout is outside its bound.");
  return new Promise((resolve, reject) => {
    const child = spawn(program, [
      "--scope", scope,
      "--subject", subjectId,
      "--check", check,
      "--revision", probeRevision,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
    });
    let stdout = "";
    let stderrSize = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_OUTPUT) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      stderrSize += chunk.length;
      if (stderrSize > MAX_OUTPUT) child.kill("SIGKILL");
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal || code !== 0) return reject(new ConnectorProbeRefused(`Connector probe "${check}" did not pass.`));
      let evidence;
      try { evidence = JSON.parse(stdout); } catch { return reject(new ConnectorProbeRefused(`Connector probe "${check}" returned malformed evidence.`)); }
      if (!evidence || Object.keys(evidence).some((key) => !["ok", "evidence"].includes(key)) || evidence.ok !== true || typeof evidence.evidence !== "string" || !evidence.evidence.trim() || evidence.evidence.length > 1000) {
        return reject(new ConnectorProbeRefused(`Connector probe "${check}" did not return positive bounded evidence.`));
      }
      resolve(true);
    });
  });
}

async function collect({ program, scope, subjectId, checks, probeRevision, run = runProbeProgram }) {
  const results = {};
  for (const check of checks) {
    results[check] = await run({ program, scope, subjectId, check, probeRevision });
  }
  return results;
}

export async function probeAndActivateInstance({ statePath, connectorId, probeRevision, program, run }) {
  const results = await collect({ program, scope: "instance", subjectId: connectorId, checks: INSTANCE_PROBES, probeRevision, run });
  return activateConnectorInstance({ statePath, connectorId, probeRevision, results });
}

export async function probeAndActivateAttachment({ statePath, attachmentId, probeRevision, program, run }) {
  const results = await collect({ program, scope: "attachment", subjectId: attachmentId, checks: ATTACHMENT_PROBES, probeRevision, run });
  return activateAttachment({ statePath, attachmentId, probeRevision, results });
}
