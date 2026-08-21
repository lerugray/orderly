// Two stand-ins, so a seat-engine test needs no model, no network and no
// installed gateway.
//
//   startMockEngine     an OpenAI-compatible endpoint, in the shape a small
//                       local server (Ollama, llama.cpp, LM Studio, vLLM)
//                       presents: GET /v1/models and POST /v1/chat/completions.
//                       Every way it can be wrong is a knob, because most of
//                       what a probe exists to catch is an endpoint that is
//                       almost right.
//
//   startStandInGateway an OpenClaw stand-in. The real gateway is a third-party
//                       package and is not what these tests are testing: what
//                       is being tested is that ORDERLY's own configuration
//                       resolves to a real endpoint that really answers. So
//                       this stand-in does exactly what the gateway documents
//                       itself as doing — take a bearer, take an agent
//                       reference, resolve that agent's model through
//                       models.providers, and call the endpoint — using
//                       ORDERLY's own resolver to do it.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolveSeatEngine, readEngineConfig } from "../engines.mjs";

function listen(server) {
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => done(server.address().port));
  });
}

function body(req) {
  return new Promise((done, fail) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => done(raw));
    req.on("error", fail);
  });
}

function json(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

export async function startMockEngine({
  key = null,
  models = [{ id: "llama3.1:8b" }],
  reply = "ready.",
  toolCalls = 0,
  brokenProtocol = false,
  modelsStatus = 200,
  completionStatus = 200,
} = {}) {
  const calls = { models: 0, completions: 0, authHeaders: [] };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://mock");
    calls.authHeaders.push(req.headers.authorization ?? null);
    if (key && req.headers.authorization !== `Bearer ${key}`) return json(res, 401, { error: "no" });

    if (req.method === "GET" && url.pathname === "/v1/models") {
      calls.models += 1;
      if (modelsStatus !== 200) return json(res, modelsStatus, { error: "no" });
      return json(res, 200, { object: "list", data: models });
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      calls.completions += 1;
      const sent = JSON.parse((await body(req)) || "{}");
      if (completionStatus !== 200) return json(res, completionStatus, { error: "no" });
      if (brokenProtocol) return json(res, 200, { choices: [{ text: reply }] });

      const message = { role: "assistant", content: reply };
      if (toolCalls > 0) {
        message.tool_calls = Array.from({ length: toolCalls }, (_, i) => ({
          id: `call_${i}`,
          type: "function",
          function: { name: "orderly_probe_echo", arguments: '{"word":"ready"}' },
        }));
      }
      if (sent.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      return json(res, 200, { model: sent.model, choices: [{ index: 0, message, finish_reason: "stop" }] });
    }

    json(res, 404, { error: "not found" });
  });
  const port = await listen(server);
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () => new Promise((done) => server.close(done)),
  };
}

export async function startStandInGateway({ configPath, enginesPath, token }) {
  const seen = { models: [], sessionKeys: [] };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://mock");
    if (url.pathname === "/health") return json(res, 200, { ok: true });
    if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: "no" });
    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") return json(res, 404, { error: "no" });

    const sent = JSON.parse((await body(req)) || "{}");
    seen.models.push(sent.model);
    seen.sessionKeys.push(req.headers["x-openclaw-session-key"] ?? null);

    const gatewayConfig = JSON.parse(await readFile(configPath, "utf8"));
    const { overlay } = await readEngineConfig({ path: enginesPath });
    const seatId = String(sent.model).slice(String(sent.model).indexOf("/") + 1);
    let binding;
    try {
      binding = resolveSeatEngine({ gatewayConfig, overlay, seatId });
    } catch (err) {
      return json(res, 400, { error: String(err.message) });
    }

    const upstream = await fetch(`${binding.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(binding.apiKeyEnv && process.env[binding.apiKeyEnv]
          ? { Authorization: `Bearer ${process.env[binding.apiKeyEnv]}` }
          : {}),
      },
      body: JSON.stringify({ ...sent, model: binding.modelId }),
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
    });
    res.end(text);
  });
  const port = await listen(server);
  return { port, seen, close: () => new Promise((done) => server.close(done)) };
}
