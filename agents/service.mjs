#!/usr/bin/env node
// HTTP-over-Unix-socket boundary between orderly-web and the gateway-owned
// named-agent control plane. The socket's filesystem mode is the authorization
// boundary; request bodies carry only the desk's fixed management vocabulary.

import { createServer } from "node:http";
import { chmod, chown, mkdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentControl, AgentRuntimeRefused } from "./control.mjs";

const MAX_REQUEST = 32 * 1024;
const AGENT_ID = /^a-[a-z0-9]{8,40}$/;

function response(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function exact(value, allowed, what) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentRuntimeRefused(`Malformed ${what}.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new AgentRuntimeRefused(`"${key}" is not part of ${what}.`);
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST) throw new AgentRuntimeRefused("The agent request is too large.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AgentRuntimeRefused("The agent request is not valid JSON."); }
}

export function createAgentRuntimeHandler({ control }) {
  if (!control || typeof control.roster !== "function") throw new AgentRuntimeRefused("Agent runtime control is not installed.");
  return async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/v1/agents") return response(res, 200, await control.roster());
      if (req.method === "GET" && req.url?.startsWith("/v1/agents/")) {
        const id = decodeURIComponent(req.url.slice("/v1/agents/".length));
        if (!AGENT_ID.test(id)) throw new AgentRuntimeRefused("Malformed agent id.");
        return response(res, 200, { agent: await control.find(id) });
      }
      if (req.method === "GET" && req.url?.startsWith("/v1/transcripts/")) {
        const id = decodeURIComponent(req.url.slice("/v1/transcripts/".length));
        if (!AGENT_ID.test(id)) throw new AgentRuntimeRefused("Malformed agent id.");
        return response(res, 200, await control.transcript(id));
      }
      if (req.method === "POST" && req.url === "/v1/transcripts/append") {
        const call = await body(req);
        exact(call, ["v", "id", "turns"], "agent transcript append");
        if (call.v !== 1 || !AGENT_ID.test(String(call.id)) || !Array.isArray(call.turns)) {
          throw new AgentRuntimeRefused("Malformed agent transcript append.");
        }
        return response(res, 200, await control.append(call.id, call.turns));
      }
      if (req.method !== "POST" || req.url !== "/v1/manage") return response(res, 404, { error: "No such agent runtime route." });
      const call = await body(req);
      const action = call?.action;
      if (action === "create") {
        exact(call, ["v", "action", "fields"], "agent creation request");
        if (call.v !== 1) throw new AgentRuntimeRefused("Unsupported agent runtime version.");
        return response(res, 200, { ok: true, ...(await control.create(call.fields)) });
      }
      if (!["activate", "update", "lifecycle", "remove"].includes(action)) throw new AgentRuntimeRefused("Unknown agent runtime action.");
      const allowed = action === "update" ? ["v", "action", "id", "fields"]
        : action === "lifecycle" ? ["v", "action", "id", "lifecycle"]
          : ["v", "action", "id"];
      exact(call, allowed, `agent ${action} request`);
      if (call.v !== 1 || !AGENT_ID.test(String(call.id))) throw new AgentRuntimeRefused("Malformed agent runtime request.");
      if (action === "activate") return response(res, 200, { ok: true, ...(await control.activate(call.id)) });
      if (action === "update") return response(res, 200, { ok: true, ...(await control.update(call.id, call.fields)) });
      if (action === "lifecycle") return response(res, 200, { ok: true, ...(await control.lifecycle(call.id, call.lifecycle)) });
      return response(res, 200, { ok: true, ...(await control.remove(call.id)) });
    } catch (error) {
      const known = error instanceof AgentRuntimeRefused || /Refused$/.test(error?.constructor?.name ?? "");
      return response(res, known ? 400 : 500, {
        error: known ? error.message : "The gateway agent runtime could not complete that request.",
      });
    }
  };
}

export async function listenAgentRuntime({ socketPath, control, socketMode = 0o660, socketGid = null }) {
  if (typeof socketPath !== "string" || !socketPath.startsWith("/")) throw new AgentRuntimeRefused("Agent runtime socket path must be absolute.");
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o750 });
  await unlink(socketPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  const server = createServer(createAgentRuntimeHandler({ control }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  if (socketGid !== null) await chown(socketPath, process.getuid(), socketGid);
  await chmod(socketPath, socketMode);
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await unlink(socketPath).catch(() => {});
  };
  return { server, close };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const root = process.env.ORDERLY_AGENT_ROOT;
  const configPath = process.env.OPENCLAW_CONFIG_PATH || process.env.ORDERLY_OPENCLAW_CONFIG;
  const socketPath = process.env.ORDERLY_AGENT_RUNTIME_SOCKET;
  try {
    const control = createAgentControl({ root, configPath });
    const migration = await control.migrate();
    const gidText = process.env.ORDERLY_AGENT_SOCKET_GID;
    const socketGid = gidText && /^\d+$/.test(gidText) ? Number(gidText) : null;
    const runtime = await listenAgentRuntime({ socketPath, control, socketGid });
    process.stdout.write(`ORDERLY agent runtime ready (${migration.migrated} migrated)\n`);
    const stop = async () => { await runtime.close(); process.exit(0); };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  } catch {
    process.stderr.write("ORDERLY agent runtime did not start.\n");
    process.exitCode = 1;
  }
}
