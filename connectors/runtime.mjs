// Host runtime control for connector attachment lifecycle.
//
// The browser never supplies a path, probe result, command, or container name.
// It sends only an attachment id and one fixed lifecycle verb to orderly-web;
// orderly-web forwards that envelope to this separately deployed, host-owned
// Unix-socket service. The service changes the runtime route first, obtains its
// own named probe evidence, and only then updates authoritative connector state.

import { request as httpRequest } from "node:http";
import { createServer } from "node:http";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import {
  activateAttachment,
  ATTACHMENT_PROBES,
  ConnectorRefused,
  readConnectorState,
  transitionAttachment,
} from "./control.mjs";

const MAX_REQUEST = 16 * 1024;
const MAX_RESPONSE = 64 * 1024;
const ATTACHMENT_ID = /^att-[a-f0-9-]{20,}$/;
const ACTIONS = new Set(["suspend", "resume", "detach"]);
const isObj = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export class ConnectorRuntimeRefused extends Error {}
const refuse = (message) => { throw new ConnectorRuntimeRefused(message); };

function exactKeys(value, allowed, what) {
  if (!isObj(value)) refuse(`Malformed ${what}.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) refuse(`Unknown ${what} field "${key}".`);
}

function checkedRequest(body) {
  exactKeys(body, ["v", "action", "attachmentId"], "connector runtime request");
  if (body.v !== 1) refuse("Unsupported connector runtime request version.");
  if (!ACTIONS.has(body.action)) refuse("Unknown connector runtime action.");
  if (typeof body.attachmentId !== "string" || !ATTACHMENT_ID.test(body.attachmentId)) {
    refuse("Malformed connector attachment id.");
  }
  return body;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST) {
        reject(new ConnectorRuntimeRefused("Connector runtime request is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function reply(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function attachmentFor(statePath, attachmentId) {
  const state = await readConnectorState(statePath);
  const attachment = state.attachments.find((item) => item.id === attachmentId);
  if (!attachment) refuse("That connector attachment does not exist.");
  return structuredClone(attachment);
}

export function createConnectorRuntimeHandler({ statePath, route, probes, probeRevision }) {
  if (typeof statePath !== "string" || !statePath.startsWith("/")) refuse("Connector runtime state path must be host-derived.");
  if (!isObj(route) || typeof route.install !== "function" || typeof route.remove !== "function") {
    refuse("Connector runtime route operations are not installed.");
  }
  if (typeof probes !== "function") refuse("Connector runtime probes are not installed.");
  if (typeof probeRevision !== "function") refuse("Connector runtime revision source is not installed.");

  return async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/lifecycle") return reply(res, 404, { error: "No such connector runtime route." });
    try {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (error) {
        if (error instanceof ConnectorRuntimeRefused) throw error;
        refuse("Connector runtime request is not valid JSON.");
      }
      const call = checkedRequest(body);
      const attachment = await attachmentFor(statePath, call.attachmentId);

      if (call.action === "suspend" || call.action === "detach") {
        const removed = await route.remove({ attachment, action: call.action });
        if (removed !== true) refuse("The runtime route was not proven removed. Connector state remains unchanged.");
        const changed = await transitionAttachment({
          statePath,
          attachmentId: attachment.id,
          lifecycle: call.action === "suspend" ? "suspended" : "detached",
          routeRemoved: true,
        });
        return reply(res, 200, { ok: true, attachment: changed });
      }

      if (attachment.lifecycle !== "suspended") refuse("Only a suspended attachment can be resumed from the desk.");
      const installed = await route.install({ attachment, action: "resume" });
      if (installed !== true) refuse("The runtime route was not installed. Connector state remains suspended.");
      const results = {};
      try {
        for (const check of ATTACHMENT_PROBES) {
          results[check] = (await probes({ attachment, check })) === true;
        }
        const revision = await probeRevision({ attachment, results });
        const changed = await activateAttachment({
          statePath,
          attachmentId: attachment.id,
          probeRevision: revision,
          results,
        });
        return reply(res, 200, { ok: true, attachment: changed });
      } catch (error) {
        await route.remove({ attachment, action: "rollback" }).catch(() => false);
        throw error;
      }
    } catch (error) {
      if (error instanceof ConnectorRuntimeRefused || error instanceof ConnectorRefused) {
        return reply(res, 400, { error: error.message });
      }
      return reply(res, 502, { error: "The connector runtime controller failed. No host detail was exposed." });
    }
  };
}

export async function listenConnectorRuntime({ socketPath, ...options }) {
  if (typeof socketPath !== "string" || !socketPath.startsWith("/")) refuse("Connector runtime socket path must be host-derived.");
  const server = createServer(createConnectorRuntimeHandler(options));
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o750 });
  await unlink(socketPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  });
  await chmod(socketPath, 0o660);
  return server;
}

export function requestConnectorLifecycle({ socketPath, action, attachmentId, timeoutMs = 30_000 }) {
  if (typeof socketPath !== "string" || !socketPath.startsWith("/")) {
    throw new ConnectorRuntimeRefused("Connector runtime control is not installed on this station.");
  }
  const body = JSON.stringify(checkedRequest({ v: 1, action, attachmentId }));
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      socketPath,
      path: "/v1/lifecycle",
      method: "POST",
      timeout: timeoutMs,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let size = 0;
      const chunks = [];
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE) req.destroy(new ConnectorRuntimeRefused("Connector runtime response is too large."));
        else chunks.push(chunk);
      });
      res.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
          return reject(new ConnectorRuntimeRefused("Connector runtime response was not valid JSON."));
        }
        if ((res.statusCode ?? 500) >= 400) return reject(new ConnectorRuntimeRefused(parsed?.error || "Connector runtime action was refused."));
        resolve(parsed);
      });
    });
    req.on("timeout", () => req.destroy(new ConnectorRuntimeRefused("Connector runtime control timed out.")));
    req.on("error", reject);
    req.end(body);
  });
}

export async function dispatchRuntimeRequest({ handler, body }) {
  const { Readable } = await import("node:stream");
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = "POST";
  req.url = "/v1/lifecycle";
  const res = {
    statusCode: null, body: "", headers: {},
    writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; return this; },
    end(chunk) { if (chunk !== undefined && chunk !== null) this.body += String(chunk); },
  };
  await handler(req, res);
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

export const RUNTIME_ACTIONS = Object.freeze([...ACTIONS]);
