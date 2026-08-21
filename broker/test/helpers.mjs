import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DispatchBroker } from "../server.mjs";

const runFile = promisify(execFile);
const HERE = resolve(fileURLToPath(import.meta.url), "..");
export const RUNNER = resolve(HERE, "..", "lane-run.sh");
export const TOKEN = "test-operator-token-with-enough-entropy";

async function testGroupAlive(pgid) {
  try {
    process.kill(Number(pgid), 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

export async function fixtureRepo() {
  const root = await mkdtemp(join(tmpdir(), "orderly-broker-test-"));
  const repo = join(root, "source");
  await runFile("git", ["init", "--initial-branch=main", repo]);
  await runFile("git", ["config", "user.name", "ORDERLY Test"], { cwd: repo });
  await runFile("git", ["config", "user.email", "orderly@example.invalid"], { cwd: repo });
  await writeFile(join(repo, "tracked.txt"), "base\n");
  await runFile("git", ["add", "tracked.txt"], { cwd: repo });
  await runFile("git", ["commit", "-m", "fixture base"], { cwd: repo });
  const { stdout } = await runFile("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
  return {
    root,
    repo,
    sha: stdout.trim(),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export function fixedPresets() {
  return [
    {
      preset_id: "change",
      cmd_template: [
        process.execPath,
        "-e",
        "const f=require('fs');process.stdin.resume();process.stdin.on('end',()=>f.appendFileSync('tracked.txt','run\\n'))",
      ],
      sandbox: "workspace-write",
      timeout_max_s: 10,
    },
    {
      preset_id: "slow",
      cmd_template: [
        process.execPath,
        "-e",
        "const f=require('fs');process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>f.appendFileSync('tracked.txt','slow\\n'),350))",
      ],
      sandbox: "workspace-write",
      timeout_max_s: 10,
    },
    {
      preset_id: "no-op",
      cmd_template: [process.execPath, "-e", "process.stdin.resume()"],
      sandbox: "workspace-write",
      timeout_max_s: 10,
    },
    {
      preset_id: "failed",
      cmd_template: [
        process.execPath,
        "-e",
        "process.stdin.resume();process.stdin.on('end',()=>process.exit(7))",
      ],
      sandbox: "workspace-write",
      timeout_max_s: 10,
    },
    {
      preset_id: "timeout",
      cmd_template: [process.execPath, "-e", "process.stdin.resume();setInterval(()=>{},1000)"],
      sandbox: "workspace-write",
      timeout_max_s: 10,
    },
    {
      preset_id: "long",
      cmd_template: [process.execPath, "-e", "process.stdin.resume();setInterval(()=>{},1000)"],
      sandbox: "workspace-write",
      timeout_max_s: 30,
    },
    {
      preset_id: "env-check",
      cmd_template: [
        process.execPath,
        "-e",
        "const f=require('fs');process.stdin.resume();process.stdin.on('end',()=>f.writeFileSync('env-seen.txt',process.env.ORDERLY_OPERATOR_TOKEN||'absent'))",
      ],
      sandbox: "workspace-write",
      timeout_max_s: 10,
    },
  ];
}

export async function startBroker({ fixture, presets = fixedPresets(), now, proposalTtlMs, seatInvoker } = {}) {
  const allowlistPath = join(fixture.root, "allowlist.json5");
  await writeFile(
    allowlistPath,
    JSON.stringify({
      repos: [{ repo_id: "fixture-sandbox", url_or_path: fixture.repo, branch: "main" }],
      presets,
    }),
  );
  const orderlyHome = join(fixture.root, "home");
  const broker = new DispatchBroker({
    orderlyHome,
    socketPath: join(orderlyHome, "broker.sock"),
    registryRoot: join(orderlyHome, "lanes"),
    allowlistPath,
    laneRunner: RUNNER,
    token: TOKEN,
    proposalTtlMs,
    now,
    ...(seatInvoker ? { seatInvoker } : {}),
    // pgrep is denied process-list access by the managed macOS test sandbox.
    // killpg(..., 0) supplies the same existence fact for these local tests;
    // production keeps the explicit pgrep -g probe required by the contract.
    watcherOptions: {
      pollMs: 20,
      stallMs: 5_000,
      stabilityMs: 5,
      sweepWaitMs: 50,
      alive: testGroupAlive,
      // This sandbox permits signalling a child PID but denies signalling the
      // Python-created negative PGID. The production default remains killpg.
      signalGroup: (pgid, signal) => process.kill(Number(pgid), signal),
    },
  });
  // The managed Codex sandbox denies bind(2), including AF_UNIX, with EPERM.
  // Exercise the exact HTTP handler directly here; deployment probes the real
  // socket on WSL. DispatchBroker.listen itself has no TCP alternative.
  await broker.init();
  return broker;
}

export function api(broker, method, path, body, token = TOKEN) {
  const encoded = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolveRequest, rejectRequest) => {
    const req = Readable.from(encoded ? [encoded] : []);
    req.method = method;
    req.url = path;
    req.headers = {
      ...(token === null ? {} : { "x-orderly-operator": token }),
      ...(encoded ? { "content-type": "application/json", "content-length": String(encoded.length) } : {}),
    };
    const res = {
      status: null,
      writeHead(status) {
        this.status = status;
      },
      end(data) {
        const text = data ? String(data) : "";
        resolveRequest({ status: this.status, body: text ? JSON.parse(text) : null });
      },
    };
    Promise.resolve(broker.handle(req, res)).catch(rejectRequest);
  });
}

export async function propose(broker, overrides = {}) {
  return api(broker, "POST", "/v1/dispatch/propose", {
    repo_id: "fixture-sandbox",
    preset_id: "change",
    brief_text: "Make the fixture change.",
    timeout_s: 5,
    ...overrides,
  });
}

export async function waitForLane(broker, id, state = "terminal", timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await api(broker, "GET", `/v1/lanes/${id}`);
    if (response.body?.state === state) return response.body;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`lane ${id} did not reach ${state}`);
}

export async function briefFor(broker, id) {
  return readFile(join(broker.registry.laneDir(id), "brief.txt"), "utf8");
}
