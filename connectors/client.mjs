import { request as httpRequest } from "node:http";

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,120}$/;
const OPERATION = /^[a-z][a-z0-9.-]{2,79}$/;
const isObj = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export class ConnectorClientRefused extends Error {}

export function callConnector({ socketPath, operation, requestId, input, timeoutMs = 30_000 }) {
  if (typeof socketPath !== "string" || !socketPath.startsWith("/")) throw new ConnectorClientRefused("Connector socket path must be host-derived.");
  if (typeof operation !== "string" || !OPERATION.test(operation)) throw new ConnectorClientRefused("Malformed connector operation.");
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) throw new ConnectorClientRefused("Malformed connector request id.");
  if (!isObj(input)) throw new ConnectorClientRefused("Connector input must be a typed object.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new ConnectorClientRefused("Connector timeout is outside its fixed bound.");
  const body = JSON.stringify({ v: 1, operation, requestId, input });
  if (Buffer.byteLength(body) > 64 * 1024) throw new ConnectorClientRefused("Connector request is too large.");

  return new Promise((resolve, reject) => {
    const req = httpRequest({
      socketPath,
      path: "/v1/call",
      method: "POST",
      timeout: timeoutMs,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let size = 0;
      const chunks = [];
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) req.destroy(new ConnectorClientRefused("Connector response is too large."));
        else chunks.push(chunk);
      });
      res.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
          return reject(new ConnectorClientRefused("Connector response was not valid JSON."));
        }
        if ((res.statusCode ?? 500) >= 400) return reject(new ConnectorClientRefused(parsed?.error || "Connector call was refused."));
        resolve(parsed);
      });
    });
    req.on("timeout", () => req.destroy(new ConnectorClientRefused("Connector call timed out.")));
    req.on("error", reject);
    req.end(body);
  });
}
