// ORDERLY — named persistent agents, milestone 1.
//
// Two halves. The first exercises the store directly: the record, the on-disk
// layout, and the three gates that make "creating an agent cannot provision a
// credential" a property of the code rather than a promise in a document. The
// second stands the real front door up against a stub gateway and checks the
// things only the whole path can show — which seat a thread is routed to, that
// a named agent cannot reach the approval queue, that its transcript is the
// station's, and that a station with no named agents behaves exactly as it did
// before any of this existed.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  activateAgent,
  AgentsRefused,
  appendTurns,
  assertCredentialFree,
  createAgent,
  DEFERRED_PROBES,
  findAgent,
  handleFrom,
  listAgents,
  probeAgent,
  readManifest,
  readTranscript,
  removeAgent,
  setLifecycle,
  updateAgent,
} from "../agents.mjs";
import { agentSessionKey, agentSystemPrompt } from "../server.mjs";

const WEB = resolve(fileURLToPath(import.meta.url), "..", "..");

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), "orderly-agents-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// The station records a turn after the reply has already gone back to the
// browser, so the assertion waits for the write rather than for the clock: a
// fixed sleep is a race dressed as a delay.
async function until(check, why, deadlineMs = 5000) {
  const stop = Date.now() + deadlineMs;
  let last;
  for (;;) {
    last = await check();
    if (last) return last;
    if (Date.now() > stop) assert.fail(`${why} (waited ${deadlineMs}ms)`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

// The store validates before it returns a promise, so a refusal can arrive
// synchronously. Taking a thunk means the helper catches it either way.
async function refusal(work) {
  try {
    await work();
  } catch (error) {
    assert.ok(error instanceof AgentsRefused, `expected a refusal, got ${error?.name}`);
    return error.message;
  }
  assert.fail("that was not refused");
}

// ---------------------------------------------------------------------------
// §1 — the record and the layout
// ---------------------------------------------------------------------------

test("a created agent carries every field the spec names, with the unbuilt ones fixed", async (t) => {
  const root = await scratch(t);
  const made = await createAgent({
    root,
    fields: { name: "Reading Log", description: "Tracks what I read and what I thought of it." },
  });

  assert.match(made.id, /^a-[a-z0-9]{8,40}$/);
  assert.equal(made.handle, "reading-log");
  // §1.2's `path` is a desk route derived from the handle, never a supplied one.
  assert.equal(made.path, "/agents/reading-log");
  assert.equal(made.agentClass, "named");
  assert.equal(made.systemLocked, false);
  // §5.2 — the first confirmation creates a PENDING identity, not an active one.
  assert.equal(made.lifecycle, "pending");
  assert.equal(made.memoryPolicy, "persistent");
  assert.deepEqual(made.capabilities, []);
  assert.deepEqual(made.delegation, []);
  assert.deepEqual(made.channels, ["web-desk"]);
  assert.deepEqual(made.sandbox, { provisioned: false, profile: null });

  const manifest = await readManifest(root);
  const record = manifest.agents[0];
  assert.equal(record.isGroup, false, "§3.4 — v1 has no group agents");
  assert.deepEqual(record.memberIds, []);
  assert.equal(record.runtimeProfile, null, "§2.1's sandbox profile is not this milestone's");
  assert.match(record.canonicalConversationId, /^c-[a-z0-9]+$/);
  // The sibling spec's engine binding: declared so it needs no migration later,
  // and empty because this milestone implements no engine plumbing.
  assert.deepEqual(record.seat, {
    model: { primary: null, fallbacks: [] },
    contextBudget: null,
    capabilityTier: null,
    harnessRef: null,
  });
});

test("the per-agent directory is the layout §1.3 prescribes, and holds no credential", async (t) => {
  const root = await scratch(t);
  const made = await createAgent({ root, fields: { name: "Reading Log" } });
  const dir = join(root, "agents", made.id);
  const found = (await readdir(dir, { recursive: true })).sort();

  for (const wanted of [
    "profile.json",
    "standing-orders.md",
    "memory",
    join("memory", "MEMORY.md"),
    join("memory", "notes"),
    "conversations",
    "media",
    "audit",
  ]) {
    assert.ok(found.includes(wanted), `${wanted} was not laid down (${found.join(", ")})`);
  }

  // §1.3's closing sentence, as an assertion: no credential file, token, keyring,
  // provider env file or credential-store symlink anywhere under this tree.
  for (const name of found) {
    assert.doesNotMatch(name, /\.(env|pem|key|p12|pfx)$|credentials?$|token$/i, name);
  }

  // The projection and the orders are the host's, not the identity's.
  assert.equal((await stat(join(dir, "profile.json"))).mode & 0o222, 0);
  assert.equal((await stat(join(dir, "standing-orders.md"))).mode & 0o222, 0);

  const profile = JSON.parse(await readFile(join(dir, "profile.json"), "utf8"));
  assert.equal(profile.id, made.id);
  assert.equal(profile.name, "Reading Log");
  // A projection of the SANITISED view: no filesystem path reaches the sandbox
  // copy any more than it reaches the browser.
  assert.equal(JSON.stringify(profile).includes(root), false);

  const orders = await readFile(join(dir, "standing-orders.md"), "utf8");
  assert.match(orders, /You hold no credential of any kind/);
  assert.match(orders, /Delegation is off/);
});

test("a memoryless agent gets no memory mount at all", async (t) => {
  const root = await scratch(t);
  const made = await createAgent({
    root,
    fields: { name: "Scratch", memoryPolicy: "memoryless" },
  });
  const found = await readdir(join(root, "agents", made.id));
  assert.equal(found.includes("memory"), false, "§4.2 — memoryless means no writable memory");
  assert.equal(made.memoryPolicy, "memoryless");
});

// ---------------------------------------------------------------------------
// §7 — creation is credential-free by construction
// ---------------------------------------------------------------------------

test("the creation envelope is typed: anything it does not own is refused by name", async (t) => {
  const root = await scratch(t);
  for (const [field, value] of [
    ["token", "abc"],
    ["env", { OPENAI_API_KEY: "x" }],
    ["image", "docker.io/thing:latest"],
    ["network", "host"],
    ["workspace", "/home/user"],
    ["runtimeProfile", "mail"],
    ["capabilityBindings", ["mail"]],
    ["delegationAllowlist", ["mail"]],
    ["lifecycle", "active"],
    ["seat", { model: { primary: "openai/gpt-5" } }],
  ]) {
    const why = await refusal(() => createAgent({ root, fields: { name: "Thing", [field]: value } }));
    assert.match(why, new RegExp(`"${field}" is not something an agent is created with`), field);
  }
  assert.deepEqual(await listAgents({ root }), [], "nothing was written by a refused create");
});

test("a name or a purpose that reads like a path, an endpoint, an assignment or a key is refused", async (t) => {
  const root = await scratch(t);
  const cases = [
    ["reads /home/user/.openclaw/.env every morning", "a filesystem path"],
    ["watches https://example.com for changes", "a URL"],
    ["run it with OPENAI_API_KEY = sk-live", "an environment assignment"],
    ["use sk-abcdefghijklmnop for this", "a credential"],
    ["-----BEGIN PRIVATE KEY-----", "a key or certificate"],
    ["mounts ../../etc/shadow", "a filesystem path"],
  ];
  for (const [description, called] of cases) {
    const why = await refusal(() => createAgent({ root, fields: { name: "Thing", description } }));
    assert.match(why, new RegExp(called.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), description);
  }
  assert.deepEqual(await listAgents({ root }), []);
});

test("the record invariant refuses a credential-shaped record even if a caller built one", () => {
  const base = {
    id: "a-abcdefgh",
    name: "Thing",
    handle: "thing",
    path: "/agents/thing",
    capabilityBindings: [],
    delegationAllowlist: [],
    channelBindings: [{ channel: "web-desk" }],
    isGroup: false,
    memberIds: [],
  };
  assert.ok(assertCredentialFree({ ...base }));

  assert.throws(() => assertCredentialFree({ ...base, token: "x" }), AgentsRefused);
  assert.throws(() => assertCredentialFree({ ...base, sandbox: { image: "alpine" } }), AgentsRefused);
  assert.throws(() => assertCredentialFree({ ...base, note: "see /etc/passwd" }), AgentsRefused);
  // The lists §2.2 and §7 say stay empty until a separate operator ruling.
  assert.throws(() => assertCredentialFree({ ...base, capabilityBindings: ["mail"] }), AgentsRefused);
  assert.throws(() => assertCredentialFree({ ...base, delegationAllowlist: ["mail"] }), AgentsRefused);
  // §3.4 reserves the group fields; an active group definition is rejected.
  assert.throws(() => assertCredentialFree({ ...base, isGroup: true }), AgentsRefused);
  // A Telegram binding is an attachment ruled on separately, not part of creation.
  assert.throws(
    () => assertCredentialFree({ ...base, channelBindings: [{ channel: "telegram" }] }),
    AgentsRefused,
  );
  // The desk route is derived; a supplied one is refused whatever it says.
  assert.throws(() => assertCredentialFree({ ...base, path: "/etc/passwd" }), AgentsRefused);
});

// ---------------------------------------------------------------------------
// §1.2 / §5.4 — handles, renames and tombstones
// ---------------------------------------------------------------------------

test("handles are derived, unique, never one of the station's own, and never reused", async (t) => {
  const root = await scratch(t);
  assert.equal(handleFrom("Reading Log!!"), "reading-log");

  const made = await createAgent({ root, fields: { name: "Reading Log" } });
  assert.match(await refusal(() => createAgent({ root, fields: { name: "Reading log" } })), /already/);
  // §2.1 — naming a thing "Mail" must not even look like it grants the mail profile.
  for (const taken of ["Mail", "Researcher", "Coordinator", "Gateway"]) {
    assert.match(
      await refusal(() => createAgent({ root, fields: { name: taken } })),
      /one of the station's own names/,
      taken,
    );
  }

  const renamed = await updateAgent({ root, id: made.id, fields: { handle: "reading-diary" } });
  assert.equal(renamed.handle, "reading-diary");
  assert.equal(renamed.path, "/agents/reading-diary");
  // The old handle is a tombstone, so someone addressing it can never reach a
  // different identity.
  assert.match(
    await refusal(() => createAgent({ root, fields: { name: "Reading Log" } })),
    /Handles are never reused/,
  );
  const manifest = await readManifest(root);
  assert.deepEqual(
    manifest.tombstones.map((stone) => stone.handle),
    ["reading-log"],
  );

  // A rename rewrites the standing orders, or the identity would introduce
  // itself as someone it no longer is.
  await updateAgent({ root, id: made.id, fields: { name: "Reading Diary" } });
  const orders = await readFile(join(root, "agents", made.id, "standing-orders.md"), "utf8");
  assert.match(orders, /Reading Diary/);
  assert.doesNotMatch(orders, /# Standing orders — Reading Log/);
});

test("only a name, a purpose and a handle are editable, and never on a system identity", async (t) => {
  const root = await scratch(t);
  const made = await createAgent({ root, fields: { name: "Reading Log" } });
  for (const field of ["lifecycle", "capabilityBindings", "runtimeProfile", "memoryPolicy", "seat"]) {
    assert.match(
      await refusal(() => updateAgent({ root, id: made.id, fields: { [field]: "x" } })),
      new RegExp(`"${field}" is not editable`),
      field,
    );
  }
  assert.match(await refusal(() => updateAgent({ root, id: "a-nosuchagent", fields: { name: "x" } })), /isn't an agent/);
});

// ---------------------------------------------------------------------------
// §5.2 / §2.4 — activation is probed, and the deferred probes are named
// ---------------------------------------------------------------------------

test("activation runs real checks and refuses to count the container ones as passed", async (t) => {
  const root = await scratch(t);
  const made = await createAgent({ root, fields: { name: "Reading Log" } });
  assert.equal(made.lifecycle, "pending");

  // The word cannot be set; the checks have to run.
  assert.match(
    await refusal(() => setLifecycle({ root, id: made.id, lifecycle: "active" })),
    /activated by running its probes, not by setting a word/,
  );

  const { agent, probe } = await activateAgent({ root, id: made.id });
  assert.equal(agent.lifecycle, "active");
  assert.equal(probe.passed, true);
  assert.ok(probe.checks.length >= 6);
  assert.ok(probe.checks.every((check) => check.ok));
  // §2.4's container probes are reported as owed, never folded into the pass.
  assert.deepEqual(probe.deferred, DEFERRED_PROBES);
  assert.ok(probe.deferred.length >= 6);
  for (const owed of probe.deferred) {
    assert.equal(
      probe.checks.some((check) => check.check === owed),
      false,
      `"${owed}" is listed as both run and owed`,
    );
  }
});

test("a probe fails on a real finding, and a failed probe activates nothing", async (t) => {
  const root = await scratch(t);
  const made = await createAgent({ root, fields: { name: "Reading Log" } });
  // Something credential-shaped appears inside the identity's own tree.
  await writeFile(join(root, "agents", made.id, "media", "provider.env"), "TOKEN=x\n");

  const record = await findAgent({ root, id: made.id });
  const probe = await probeAgent({ root, record });
  assert.equal(probe.passed, false);
  const failed = probe.checks.find((check) => !check.ok);
  assert.match(failed.check, /no credential file/);

  assert.match(await refusal(() => activateAgent({ root, id: made.id })), /no credential file/);
  assert.equal((await findAgent({ root, id: made.id })).lifecycle, "pending");
});

// ---------------------------------------------------------------------------
// §4.4 — retirement is not deletion
// ---------------------------------------------------------------------------

test("retiring keeps everything and reserves the handle; removing is the second, separate act", async (t) => {
  const root = await scratch(t);
  const made = await createAgent({ root, fields: { name: "Reading Log" } });
  await activateAgent({ root, id: made.id });
  await appendTurns({ root, id: made.id, turns: [{ role: "user", content: "remember this" }] });

  assert.match(await refusal(() => removeAgent({ root, id: made.id })), /Retire the identity first/);

  const retired = await setLifecycle({ root, id: made.id, lifecycle: "retired" });
  assert.equal(retired.lifecycle, "retired");
  // The record, the transcript and the audit history survive retirement.
  assert.equal((await listAgents({ root })).length, 1);
  assert.deepEqual(
    (await readTranscript({ root, id: made.id })).map((turn) => turn.content),
    ["remember this"],
  );
  assert.match(await refusal(() => updateAgent({ root, id: made.id, fields: { name: "x" } })), /retired/);

  await removeAgent({ root, id: made.id });
  assert.deepEqual(await listAgents({ root }), []);
  assert.equal(
    await readdir(join(root, "agents", made.id)).then(() => "there", () => "gone"),
    "gone",
  );
  // And the handle stays reserved even after the identity is gone.
  assert.match(
    await refusal(() => createAgent({ root, fields: { name: "Reading Log" } })),
    /Handles are never reused/,
  );
});

test("suspending stops a thread and resuming starts it again", async (t) => {
  const root = await scratch(t);
  const made = await createAgent({ root, fields: { name: "Reading Log" } });
  await activateAgent({ root, id: made.id });
  assert.equal((await setLifecycle({ root, id: made.id, lifecycle: "suspended" })).lifecycle, "suspended");
  assert.equal((await setLifecycle({ root, id: made.id, lifecycle: "active" })).lifecycle, "active");
});

// ---------------------------------------------------------------------------
// §4.1 — the transcript is the station's
// ---------------------------------------------------------------------------

test("a transcript survives being re-read from a cold store and is capped, not unbounded", async (t) => {
  const root = await scratch(t);
  const made = await createAgent({ root, fields: { name: "Reading Log" } });
  await appendTurns({
    root,
    id: made.id,
    turns: [
      { role: "user", content: "what did I say about Sebald" },
      { role: "assistant", content: "you called it the best sentence in the book" },
      { role: "system", content: "this is not a role a transcript keeps" },
    ],
  });
  const turns = await readTranscript({ root, id: made.id });
  assert.deepEqual(turns.map((turn) => turn.role), ["user", "assistant"]);
  assert.ok(turns.every((turn) => typeof turn.at === "string"));

  // A turn longer than the front door's own message cap is truncated, not stored whole.
  await appendTurns({ root, id: made.id, turns: [{ role: "user", content: "x".repeat(20_000) }] });
  const long = (await readTranscript({ root, id: made.id })).at(-1);
  assert.equal(long.content.length, 6000);
});

// ---------------------------------------------------------------------------
// the whole front door, against a stub gateway
// ---------------------------------------------------------------------------

function stubGateway() {
  const seen = [];
  let reply = "Noted.";
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"status":"ok"}');
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        // Two frames, deliberately: the front door reassembles the reply out of
        // the deltas, so a single-frame stub would not exercise the seam.
        for (const part of [reply.slice(0, 4), reply.slice(4)]) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
        }
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ choices: [{ message: { content: reply } }] }),
      );
    });
  });
  return {
    server,
    seen,
    say(text) {
      reply = text;
    },
  };
}

function waitForServer(child) {
  return new Promise((ready, reject) => {
    let out = "";
    let err = "";
    const timer = setTimeout(() => reject(new Error(`front door never listened\n${out}\n${err}`)), 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (!match) return;
      clearTimeout(timer);
      ready({ port: Number(match[1]), stderr: () => err });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`front door exited before listening (${code ?? signal})\n${err}`));
    });
  });
}

async function station(t, env) {
  const child = spawn(process.execPath, [join(WEB, "server.mjs")], {
    cwd: WEB,
    env: { ...process.env, ORDERLY_WEB_PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await new Promise((done) => child.once("exit", done));
  });
  return { child, ready: await waitForServer(child) };
}

test("the front door routes desks and named agents to different seats and different sessions", async (t) => {
  const root = await scratch(t);
  const gateway = stubGateway();
  try {
    await new Promise((ok, no) => {
      gateway.server.once("error", no);
      gateway.server.listen(0, "127.0.0.1", ok);
    });
  } catch (error) {
    if (/EPERM|EACCES/.test(String(error?.message))) {
      t.skip("sandbox denies loopback listen; the harvest host must run this test");
      return;
    }
    throw error;
  }
  t.after(() => new Promise((done) => gateway.server.close(done)));
  const gatewayPort = gateway.server.address().port;

  const env = {
    HOME: root,
    ORDERLY_GATEWAY_PORT: String(gatewayPort),
    ORDERLY_AGENTS_ROOT: join(root, "agents-root"),
    ORDERLY_QUEUE_STATE: join(root, "queue-state.json"),
    ORDERLY_PENDING: join(root, "no-such-pending.md"),
    ORDERLY_SETTINGS_WRITE: "off",
    OPENCLAW_GATEWAY_TOKEN: "test-bearer",
    // Named threads answer on their own declared seat, so the routing is
    // visible rather than being the same string as the coordinator's.
    ORDERLY_AGENT_SEAT: "openclaw/named-seat",
  };

  let front;
  try {
    front = await station(t, env);
  } catch (error) {
    if (/EPERM|EACCES/.test(String(error?.message))) {
      t.skip("sandbox denies loopback listen; the harvest host must run this test");
      return;
    }
    throw error;
  }
  const base = `http://127.0.0.1:${front.ready.port}`;
  const api = (path, body) =>
    fetch(`${base}${path}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : { Accept: "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  // --- migration §6: a station with no named agents is the station as it was.
  const before = await (await api("/api/agents")).json();
  assert.deepEqual(before.agents, []);
  assert.deepEqual(
    before.system.map((agent) => agent.id),
    ["coordinator", "mail", "orchestration"],
  );

  const deskReply = await api("/api/chat", {
    desk: "coordinator",
    thread: "abcd1234",
    stream: false,
    messages: [{ role: "user", content: "morning" }],
  });
  assert.equal(deskReply.status, 200);
  const deskCall = gateway.seen.at(-1);
  assert.equal(deskCall.body.model, "openclaw/coordinator");
  assert.equal(deskCall.headers["x-openclaw-session-key"], "orderly-web:coordinator:abcd1234");
  assert.match(deskCall.body.messages[0].content, /orderly-card/, "the fixed desks keep the card contract");

  // --- a named agent
  const made = await (
    await api("/api/agents", {
      action: "create",
      name: "Reading Log",
      description: "Tracks what I read.",
    })
  ).json();
  assert.equal(made.ok, true);
  const id = made.agent.id;

  // Pending is not a thing you can talk to.
  const tooSoon = await api("/api/chat", {
    agent: id,
    stream: false,
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(tooSoon.status, 409);
  const stranger = await api("/api/chat", {
    agent: "a-doesnotexist1",
    stream: false,
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(stranger.status, 404);

  const activated = await (await api("/api/agents", { action: "activate", id })).json();
  assert.equal(activated.probe.passed, true);

  gateway.say("Noted.\n\n```orderly-card\n" + JSON.stringify({
    kind: "draft",
    title: "A draft",
    account: "personal",
    to: "someone@example.com",
    subject: "Re: a thing",
    body: "hello",
  }) + "\n```");

  const agentReply = await api("/api/chat", {
    agent: id,
    stream: false,
    messages: [{ role: "user", content: "what did I read last week" }],
  });
  assert.equal(agentReply.status, 200);
  const agentCall = gateway.seen.at(-1);
  assert.equal(agentCall.body.model, "openclaw/named-seat", "a named thread is not the coordinator desk");
  assert.equal(agentCall.headers["x-openclaw-session-key"], agentSessionKey(id));
  const system = agentCall.body.messages[0].content;
  assert.match(system, /"Reading Log"/);
  assert.match(system, /You hold no credential/);
  assert.match(system, /may not ask/);
  // §7 — no card contract: an identity with no mailbox is never invited to
  // produce a card that would land on the approval queue.
  assert.doesNotMatch(system, /```orderly-card|kind":"draft/);

  // ...and even when the seat emits one anyway, it reaches the queue by no path.
  const queue = await (await api("/api/queue")).json();
  assert.equal(queue.counts.pending, 0, "a named agent's card must not reach the approval queue");

  // §4.1 — the station wrote the transcript, both halves of it.
  const thread = await until(async () => {
    const seenSoFar = await (await api(`/api/agents/thread?agent=${id}`)).json();
    return seenSoFar.turns.length >= 2 ? seenSoFar : null;
  }, "the reply never reached the transcript");
  assert.deepEqual(
    thread.turns.map((turn) => turn.role),
    ["user", "assistant"],
  );
  assert.equal(thread.turns[0].content, "what did I read last week");

  // --- streaming, which is what the page actually uses.
  //
  // This half is also the regression test for a defect this milestone found in
  // the path it had to ride: the SSE watcher decoded its chunks with
  // Uint8Array.toString("utf8"), which returns the bytes as decimal numbers, so
  // it never saw a frame. Nothing streamed was watched — no transcript, and no
  // draft or event card from any streamed reply either, on any desk.
  gateway.say("Filed.");
  const streamed = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent: id,
      stream: true,
      messages: [{ role: "user", content: "and the week before" }],
    }),
  });
  assert.equal(streamed.status, 200);
  assert.match(await streamed.text(), /data: /);
  const afterStream = await until(async () => {
    const seenSoFar = await (await api(`/api/agents/thread?agent=${id}`)).json();
    return seenSoFar.turns.length >= 4 ? seenSoFar : null;
  }, "the streamed reply never reached the transcript");
  assert.deepEqual(
    afterStream.turns.map((turn) => turn.role),
    ["user", "assistant", "user", "assistant"],
    "a streamed reply must reach the transcript, not only a non-streamed one",
  );
  assert.equal(afterStream.turns[2].content, "and the week before");
  assert.equal(afterStream.turns[3].content, "Filed.");
  // The earlier reply's card text is kept in the transcript verbatim and still
  // reached the queue by no path — the record is honest about what was said.
  assert.match(afterStream.turns[1].content, /orderly-card/);

  // ...and the same decoding fix means a streamed COORDINATOR reply files its
  // card, which is what the approval queue was built to do in the first place.
  gateway.say("One draft.\n\n```orderly-card\n" + JSON.stringify({
    kind: "draft",
    title: "A draft",
    account: "personal",
    to: "someone@example.com",
    subject: "Re: the thing",
    body: "hello",
  }) + "\n```");
  await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      desk: "coordinator",
      thread: "abcd1234",
      stream: true,
      messages: [{ role: "user", content: "draft a reply" }],
    }),
  }).then((res) => res.text());
  await until(async () => {
    const queueNow = await (await api("/api/queue")).json();
    return queueNow.counts.pending === 1;
  }, "a streamed draft card must reach the approval queue");

  // --- and it survives the service being restarted.
  front.child.kill("SIGTERM");
  await new Promise((done) => front.child.once("exit", done));
  const again = await station(t, env);
  const afterBase = `http://127.0.0.1:${again.ready.port}`;
  const roster = await (await fetch(`${afterBase}/api/agents`)).json();
  assert.equal(roster.agents.length, 1);
  assert.equal(roster.agents[0].id, id);
  assert.equal(roster.agents[0].lifecycle, "active");
  const survived = await (await fetch(`${afterBase}/api/agents/thread?agent=${id}`)).json();
  assert.equal(survived.turns.length, 4);
  assert.equal(survived.turns[0].content, "what did I read last week");
  assert.equal(survived.turns.at(-1).content, "Filed.");
});

// ---------------------------------------------------------------------------
// §6 — the fixed seats are untouched
// ---------------------------------------------------------------------------

test("the system prompt for a named agent grants nothing the coordinator's does", () => {
  const prompt = agentSystemPrompt({ name: "Reading Log", description: "Tracks what I read." });
  assert.match(prompt, /no credential/);
  assert.match(prompt, /no network of your own/);
  assert.match(prompt, /no delegation/);
  // No card contract: the schemas that let a reply become an approval-queue
  // card are absent, and the one mention of them is a prohibition.
  assert.doesNotMatch(prompt, /\{"kind":"draft"|\{"kind":"event"/);
  assert.match(prompt, /Never emit fenced blocks/);
  assert.equal(agentSessionKey("a-abcdefgh"), "orderly-web:agent:a-abcdefgh");
});

test("the station page adds named desks without disturbing the two it shipped with", async () => {
  const source = await readFile(join(WEB, "public", "orderly.js"), "utf8");
  // The fixed desks are still the literal two, and still the only ones written
  // to this browser's own store.
  assert.match(source, /const histories = \{ coordinator: \[\], mail: \[\] \};/);
  assert.match(source, /live: \{ coordinator: histories\.coordinator, mail: histories\.mail \}/);
  // A named desk is keyed by the immutable id, so a rename cannot move a thread.
  assert.match(source, /const AGENT_DESK = \/\^agent:\(a-\[a-z0-9\]\{8,40\}\)\$\//);
  assert.match(source, /agent: agentIdFor\(at\)/);
  // Only ACTIVE named agents get a desk (§3.1).
  assert.match(source, /\.filter\(\(agent\) => agent\.lifecycle === "active"\)/);
  // The desk buttons are looked up when needed, because they are drawn now.
  assert.doesNotMatch(source, /const deskOpts = Array\.from/);
});

test("the roster page offers no control §5.1 forbids", async () => {
  const html = await readFile(join(WEB, "public", "agents.html"), "utf8");
  const script = await readFile(join(WEB, "public", "agents.js"), "utf8");
  for (const forbidden of [/type="password"/, /type="file"/, /name="env"/, /name="image"/, /name="path"/]) {
    assert.doesNotMatch(html, forbidden, String(forbidden));
  }
  // The four fields it does have, and no fifth.
  const named = [...html.matchAll(/<(?:input|textarea|select)\b[^>]*\bname="([a-zA-Z]+)"/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(named, ["description", "handle", "memoryPolicy", "name"]);
  // The digest §5.2 requires, in the page's own words.
  assert.match(script, /Network: none/);
  assert.match(script, /Credentials: none/);
  assert.match(script, /Delegation: none/);
  assert.match(script, /It starts pending/);
  // Nothing on this page is built out of markup: a name and a purpose are the
  // operator's own text, and they reach the page as text nodes.
  assert.doesNotMatch(script, /\.(innerHTML|outerHTML|insertAdjacentHTML)\s*[=(]/);
});
