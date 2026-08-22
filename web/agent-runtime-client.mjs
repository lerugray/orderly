import { request as httpRequest } from "node:http";

const MAX_RESPONSE = 256 * 1024;

export class AgentRuntimeClientRefused extends Error {}

export function requestAgentRuntime({ socketPath, method = "GET", path, body = null, timeoutMs = 180_000 }) {
  if (typeof socketPath !== "string" || !socketPath.startsWith("/")) {
    throw new AgentRuntimeClientRefused("The gateway agent runtime is not installed on this station.");
  }
  const encoded = body === null ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      socketPath,
      method,
      path,
      timeout: timeoutMs,
      headers: encoded === null ? { Accept: "application/json" } : {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(encoded),
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE) {
          req.destroy(new AgentRuntimeClientRefused("The gateway agent runtime response was too large."));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { return reject(new AgentRuntimeClientRefused("The gateway agent runtime returned an unreadable response.")); }
        if ((res.statusCode ?? 500) >= 400) return reject(new AgentRuntimeClientRefused(value?.error || "The gateway agent runtime refused the request."));
        resolve(value);
      });
    });
    req.on("timeout", () => req.destroy(new AgentRuntimeClientRefused("The gateway agent runtime timed out.")));
    req.on("error", (error) => reject(error instanceof AgentRuntimeClientRefused ? error : new AgentRuntimeClientRefused("The gateway agent runtime is unavailable.")));
    if (encoded !== null) req.end(encoded); else req.end();
  });
}

export const agentRuntimeRoster = ({ socketPath }) => requestAgentRuntime({ socketPath, path: "/v1/agents" });
export const agentRuntimeFind = ({ socketPath, id }) => requestAgentRuntime({ socketPath, path: `/v1/agents/${encodeURIComponent(id)}` })
  .then((value) => value.agent);
export const agentRuntimeTranscript = ({ socketPath, id }) => requestAgentRuntime({
  socketPath,
  path: `/v1/transcripts/${encodeURIComponent(id)}`,
});
export const agentRuntimeAppend = ({ socketPath, id, turns }) => requestAgentRuntime({
  socketPath,
  method: "POST",
  path: "/v1/transcripts/append",
  body: { v: 1, id, turns },
});
export const agentRuntimeManage = ({ socketPath, action, ...fields }) => requestAgentRuntime({
  socketPath,
  method: "POST",
  path: "/v1/manage",
  body: { v: 1, action, ...fields },
});
