#!/usr/bin/env node
// ORDERLY dispatch broker — typed host actions over one UNIX socket.
//
// Request text can select only allowlist IDs and bounded scalar fields. Repo
// paths, commands, flags, models and environment entries all originate in the
// host-owned allowlist. The operator's brief is written to a file and streamed
// from that file to the fixed command's stdin; it never becomes argv.

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile as runFile } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { LaneRegistry } from "./registry.mjs";
import { buildEmptyHarvest } from "./harvest.mjs";
import { SeatInvoker } from "./seat.mjs";
import { LaneWatcher, isProcessGroupAlive, sweepProcessGroup } from "./watcher.mjs";

const runFileAsync = promisify(runFile);
const HERE = resolve(fileURLToPath(import.meta.url), "..");
const DEFAULT_HOME = join(homedir(), ".orderly");
const MAX_BODY = 128 * 1024;
const MAX_BRIEF = 64 * 1024;
const MAX_ASK = 12 * 1024;
const PROPOSAL_TTL_MS = 15 * 60 * 1000;
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const GIT_SHA = /^[a-f0-9]{40,64}$/;

export class BrokerRefused extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function stripJson5(source) {
  let output = "";
  let quote = null;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (quote) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"') {
      quote = char;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    output += char;
  }
  // This intentionally supports only the JSON subset plus comments and
  // trailing commas. Unquoted keys, expressions and JSON5 numeric extensions
  // do not belong in a security boundary.
  return output.replace(/,\s*([}\]])/g, "$1");
}

function exactKeys(object, keys, label) {
  if (!object || typeof object !== "object" || Array.isArray(object)) {
    throw new BrokerRefused(400, `${label} must be a JSON object`);
  }
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new BrokerRefused(400, `${label} has unknown or missing fields`);
  }
}

function validateAllowlist(config) {
  exactKeys(config, ["repos", "presets"], "allowlist");
  if (!Array.isArray(config.repos) || !Array.isArray(config.presets)) {
    throw new Error("allowlist repos and presets must be arrays");
  }
  const repos = new Map();
  for (const repo of config.repos) {
    exactKeys(repo, ["repo_id", "url_or_path", "branch"], "allowlist repo");
    if (!ID.test(repo.repo_id) || typeof repo.url_or_path !== "string" || !repo.url_or_path) {
      throw new Error("allowlist repo has an invalid id or source");
    }
    if (typeof repo.branch !== "string" || !/^[A-Za-z0-9._/-]{1,200}$/.test(repo.branch)) {
      throw new Error(`allowlist repo ${repo.repo_id} has an invalid branch`);
    }
    if (repos.has(repo.repo_id)) throw new Error(`duplicate repo_id ${repo.repo_id}`);
    repos.set(repo.repo_id, Object.freeze({ ...repo }));
  }
  const presets = new Map();
  for (const preset of config.presets) {
    exactKeys(preset, ["preset_id", "cmd_template", "sandbox", "timeout_max_s"], "allowlist preset");
    if (!ID.test(preset.preset_id) || !Array.isArray(preset.cmd_template) || !preset.cmd_template.length) {
      throw new Error("allowlist preset has an invalid id or command template");
    }
    if (!preset.cmd_template.every((part) => typeof part === "string" && part.length > 0)) {
      throw new Error(`preset ${preset.preset_id} command must be fixed string argv`);
    }
    if (preset.sandbox !== "workspace-write") {
      throw new Error(`preset ${preset.preset_id} must pin sandbox workspace-write`);
    }
    if (!Number.isInteger(preset.timeout_max_s) || preset.timeout_max_s < 1 || preset.timeout_max_s > 86_400) {
      throw new Error(`preset ${preset.preset_id} has an invalid timeout ceiling`);
    }
    if (presets.has(preset.preset_id)) throw new Error(`duplicate preset_id ${preset.preset_id}`);
    presets.set(preset.preset_id, Object.freeze({ ...preset, cmd_template: Object.freeze([...preset.cmd_template]) }));
  }
  return { repos, presets };
}

export async function loadAllowlist(path) {
  return validateAllowlist(JSON.parse(stripJson5(await readFile(path, "utf8"))));
}

export function buildCommand(preset) {
  // There are deliberately no placeholders. cwd, timeout and brief transport
  // are wrapper concerns and cannot alter this fixed argv.
  return [...preset.cmd_template];
}

function digestOfBrief(brief) {
  return createHash("sha256").update(brief, "utf8").digest("hex");
}

function tokenMatches(expected, supplied) {
  const left = createHash("sha256").update(String(expected || "")).digest();
  const right = createHash("sha256").update(String(supplied || "")).digest();
  return Boolean(expected) && Boolean(supplied) && timingSafeEqual(left, right);
}

function laneForApi(lane) {
  return {
    id: lane.id,
    repo_id: lane.repo_id,
    base_sha: lane.base_sha,
    brief_sha256: lane.brief_sha256,
    preset_id: lane.preset_id,
    timeout_s: lane.timeout_s,
    state: lane.state,
    terminal_class: lane.terminal_class,
    terminal_record: lane.terminal_record,
    harvest: lane.harvest,
    log_excerpt: lane.log_excerpt,
    created_ts: lane.created_ts,
    dispatched_ts: lane.dispatched_ts,
    terminal_ts: lane.terminal_ts,
  };
}

export function allowlistForApi(allowlist) {
  return {
    repos: [...allowlist.repos.values()].map((repo) => ({
      repo_id: repo.repo_id,
      branch: repo.branch,
    })),
    presets: [...allowlist.presets.values()].map((preset) => ({
      preset_id: preset.preset_id,
      timeout_max_s: preset.timeout_max_s,
    })),
  };
}

function safeLaneEnvironment(laneHome) {
  // ORDERLY_OPERATOR_TOKEN and every unrelated service credential are omitted.
  // HOME is fixed by the host, never by chat, so an installed codex CLI can use
  // its own host authentication while its workspace sandbox remains pinned.
  return {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME || laneHome,
    LANG: process.env.LANG || "C.UTF-8",
    LC_ALL: process.env.LC_ALL || "C.UTF-8",
  };
}

function safeGitEnvironment(orderlyHome) {
  // Git gets no service credentials, user hooks, credential helpers, SSH
  // settings or interactive prompt. Phase 1 repos must therefore be local or
  // publicly readable; private-repo credentials are an explicit anti-goal.
  return {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: join(orderlyHome, "git-home"),
    LANG: process.env.LANG || "C.UTF-8",
    LC_ALL: process.env.LC_ALL || "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function waitForFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return (await readFile(path, "utf8")).trim();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

async function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY) throw new BrokerRefused(413, "request body is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BrokerRefused(400, "request body must be JSON");
  }
}

export class DispatchBroker {
  constructor({
    orderlyHome = DEFAULT_HOME,
    socketPath = join(orderlyHome, "broker.sock"),
    registryRoot = join(orderlyHome, "lanes"),
    allowlistPath = join(HERE, "allowlist.json5"),
    laneRunner = join(HERE, "lane-run.sh"),
    token = process.env.ORDERLY_OPERATOR_TOKEN,
    proposalTtlMs = PROPOSAL_TTL_MS,
    now = () => Date.now(),
    watcherOptions = {},
    seatInvoker = new SeatInvoker(),
  } = {}) {
    this.orderlyHome = orderlyHome;
    this.socketPath = socketPath;
    this.allowlistPath = allowlistPath;
    this.laneRunner = laneRunner;
    this.token = token;
    this.proposalTtlMs = proposalTtlMs;
    this.now = now;
    this.seatInvoker = seatInvoker;
    this.registry = new LaneRegistry(registryRoot);
    this.server = createServer(
      {
        headersTimeout: 5_000,
        keepAliveTimeout: 1_000,
        maxHeaderSize: 16 * 1024,
        requestTimeout: 10_000,
      },
      (req, res) => void this.handle(req, res),
    );
    this.server.maxRequestsPerSocket = 100;
    this.groupAlive = watcherOptions.alive || isProcessGroupAlive;
    this.sweepWaitMs = watcherOptions.sweepWaitMs || 2_000;
    this.signalGroup = watcherOptions.signalGroup;
    this.watcher = new LaneWatcher({
      registry: this.registry,
      onTerminal: async () => this.startNext(),
      ...watcherOptions,
    });
    this.starting = false;
    this.confirmLocks = new Map();
  }

  async init() {
    if (!this.token) throw new Error("ORDERLY_OPERATOR_TOKEN is required");
    this.allowlist = await loadAllowlist(this.allowlistPath);
    await mkdir(join(this.orderlyHome, "git-home"), { recursive: true, mode: 0o700 });
    await this.registry.load();
    const reconciled = await this.registry.reconcile(this.groupAlive);
    for (const id of reconciled.dead) await this.watcher.completeReconciled(id).catch(() => {});
    for (const id of reconciled.live) await this.watcher.arm(id);
    await this.startNext();
  }

  async listen() {
    await this.init();
    // The desk group needs search permission to reach broker.sock, never write
    // permission on the directory (which would allow unlinking broker state).
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o710 });
    await chmod(dirname(this.socketPath), 0o710);
    try {
      const info = await lstat(this.socketPath);
      if (!info.isSocket()) throw new Error(`refusing to replace non-socket ${this.socketPath}`);
      await rm(this.socketPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolveListen, rejectListen) => {
      const failed = (error) => rejectListen(error);
      this.server.once("error", failed);
      this.server.listen(this.socketPath, () => {
        this.server.off("error", failed);
        resolveListen();
      });
    });
    await chmod(this.socketPath, 0o660);
    return this;
  }

  async close() {
    this.watcher.close();
    if (this.server.listening) await new Promise((resolveClose) => this.server.close(resolveClose));
    await rm(this.socketPath, { force: true }).catch(() => {});
  }

  authenticate(req) {
    if (!tokenMatches(this.token, req.headers["x-orderly-operator"])) {
      throw new BrokerRefused(401, "operator authentication required");
    }
  }

  async baseSha(repo) {
    const { stdout } = await runFileAsync(
      "git",
      ["ls-remote", "--exit-code", repo.url_or_path, `refs/heads/${repo.branch}`],
      {
        encoding: "utf8",
        env: safeGitEnvironment(this.orderlyHome),
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
      },
    );
    const sha = String(stdout).trim().split(/\s+/)[0];
    if (!GIT_SHA.test(sha)) throw new BrokerRefused(409, "allowlisted branch did not resolve to a commit");
    return sha;
  }

  async propose(body) {
    if (this.registry.data.frozen) throw new BrokerRefused(423, "broker is frozen");
    exactKeys(body, ["repo_id", "preset_id", "brief_text", "timeout_s"], "proposal");
    if (!ID.test(body.repo_id) || !this.allowlist.repos.has(body.repo_id)) {
      throw new BrokerRefused(404, "unknown repo_id");
    }
    if (!ID.test(body.preset_id) || !this.allowlist.presets.has(body.preset_id)) {
      throw new BrokerRefused(404, "unknown preset_id");
    }
    if (typeof body.brief_text !== "string" || !body.brief_text.trim() || Buffer.byteLength(body.brief_text) > MAX_BRIEF) {
      throw new BrokerRefused(400, "brief_text must be non-empty and at most 64 KiB");
    }
    const preset = this.allowlist.presets.get(body.preset_id);
    if (!Number.isInteger(body.timeout_s) || body.timeout_s < 1 || body.timeout_s > preset.timeout_max_s) {
      throw new BrokerRefused(400, "timeout_s exceeds the preset ceiling");
    }
    const repo = this.allowlist.repos.get(body.repo_id);
    const digest = {
      repo_id: body.repo_id,
      base_sha: await this.baseSha(repo),
      brief_sha256: digestOfBrief(body.brief_text),
      preset_id: body.preset_id,
      timeout_s: body.timeout_s,
    };
    const createdMs = this.now();
    const proposal = {
      proposal_id: randomUUID(),
      digest,
      brief_text: body.brief_text,
      created_ms: createdMs,
      expires_ms: createdMs + this.proposalTtlMs,
      lane_id: null,
    };
    await this.registry.putProposal(proposal);
    return { proposal_id: proposal.proposal_id, digest };
  }

  async confirm(body) {
    if (this.registry.data.frozen) throw new BrokerRefused(423, "broker is frozen");
    exactKeys(body, ["proposal_id", "digest_ack"], "confirmation");
    if (typeof body.proposal_id !== "string") throw new BrokerRefused(400, "invalid proposal_id");
    const proposal = this.registry.proposal(body.proposal_id);
    if (!proposal) throw new BrokerRefused(404, "unknown proposal_id");
    if (JSON.stringify(body.digest_ack) !== JSON.stringify(proposal.digest)) {
      throw new BrokerRefused(409, "digest_ack does not byte-match the proposal digest");
    }
    if (proposal.lane_id) return { lane_id: proposal.lane_id };
    if (this.now() >= proposal.expires_ms) throw new BrokerRefused(410, "proposal expired");

    // Concurrent replays share creation only after each request independently
    // passes its digest check. The registry snapshot below binds proposal and
    // lane atomically, so the same property survives a process restart.
    const existing = this.confirmLocks.get(proposal.proposal_id);
    if (existing) return existing;
    const confirmation = this.createLaneForProposal(proposal).finally(() => {
      this.confirmLocks.delete(proposal.proposal_id);
    });
    this.confirmLocks.set(proposal.proposal_id, confirmation);
    return confirmation;
  }

  async consult(body) {
    exactKeys(body, ["ask"], "seat consultation");
    if (typeof body.ask !== "string" || !body.ask.trim() || Buffer.byteLength(body.ask) > MAX_ASK) {
      throw new BrokerRefused(400, "ask must be non-empty and at most 12 KiB");
    }
    return this.seatInvoker.consult({
      ask: body.ask,
      allowlist: allowlistForApi(this.allowlist),
      laneRegistry: this.registry.lanes().map(laneForApi),
    });
  }

  async createLaneForProposal(proposal) {
    const timestamp = new Date(this.now()).toISOString();
    const lane = {
      id: randomUUID(),
      repo_id: proposal.digest.repo_id,
      base_sha: proposal.digest.base_sha,
      brief_sha256: proposal.digest.brief_sha256,
      preset_id: proposal.digest.preset_id,
      timeout_s: proposal.digest.timeout_s,
      state: "proposed",
      terminal_class: null,
      terminal_record: null,
      harvest: null,
      log_excerpt: null,
      created_ts: timestamp,
      dispatched_ts: null,
      terminal_ts: null,
      runtime: null,
    };
    await mkdir(this.registry.laneDir(lane.id), { recursive: true, mode: 0o700 });
    await writeFile(join(this.registry.laneDir(lane.id), "brief.txt"), proposal.brief_text, { mode: 0o600 });
    await this.registry.confirmProposal(proposal.proposal_id, lane, timestamp);
    await this.startNext();
    return { lane_id: lane.id };
  }

  boardBlockedByLiveUncleanGroup() {
    return this.registry.lanes().some(
      (lane) => lane.state === "terminal" && lane.terminal_class === "process-unclean" && lane.runtime?.group_alive,
    );
  }

  async startNext() {
    if (this.starting || this.registry.activeLane() || this.boardBlockedByLiveUncleanGroup()) return;
    const lane = this.registry.queuedLane();
    if (!lane) return;
    this.starting = true;
    try {
      await this.startLane(lane);
    } finally {
      this.starting = false;
    }
    // A clone/launch failure can become terminal inside startLane while the
    // starting guard is still held. Give the next queued lane its own turn.
    if (!this.registry.activeLane()) await this.startNext();
  }

  async startLane(lane) {
    const repo = this.allowlist.repos.get(lane.repo_id);
    const preset = this.allowlist.presets.get(lane.preset_id);
    const laneDir = this.registry.laneDir(lane.id);
    const workdir = join(laneDir, "worktree");
    const logPath = join(laneDir, "lane.log");
    const stem = logPath.slice(0, -4);
    await this.registry.updateLane(lane.id, {
      state: "dispatched",
      dispatched_ts: new Date(this.now()).toISOString(),
      runtime: {
        workdir,
        log_path: logPath,
        done_path: `${stem}.done`,
        exit_path: `${stem}.exit`,
        pgid_path: `${stem}.pgid`,
        sweep_path: `${stem}.sweep`,
        timeout_path: `${stem}.timeout`,
        cancel_path: `${stem}.cancel`,
        pgid: null,
        wrapper_pid: null,
        group_alive: false,
      },
    });
    let child = null;
    let checkoutVerified = false;
    try {
      await runFileAsync("git", ["clone", "--no-hardlinks", "--no-checkout", "--", repo.url_or_path, workdir], {
        env: safeGitEnvironment(this.orderlyHome),
        maxBuffer: 4 * 1024 * 1024,
        timeout: 5 * 60_000,
        windowsHide: true,
      });
      await runFileAsync("git", ["checkout", "--detach", lane.base_sha], {
        cwd: workdir,
        env: safeGitEnvironment(this.orderlyHome),
        maxBuffer: 4 * 1024 * 1024,
        timeout: 2 * 60_000,
        windowsHide: true,
      });
      const { stdout: head } = await runFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: workdir,
        encoding: "utf8",
        env: safeGitEnvironment(this.orderlyHome),
        timeout: 30_000,
      });
      const { stdout: dirty } = await runFileAsync("git", ["status", "--porcelain=v1"], {
        cwd: workdir,
        encoding: "utf8",
        env: safeGitEnvironment(this.orderlyHome),
        timeout: 30_000,
      });
      if (String(head).trim() !== lane.base_sha || String(dirty).length) {
        throw new Error("fresh lane checkout failed base/clean verification");
      }
      checkoutVerified = true;
      await writeFile(logPath, "", { mode: 0o600 });
      const command = buildCommand(preset);
      child = runFile(
        "bash",
        [this.laneRunner, lane.id, workdir, logPath, String(lane.timeout_s), "--", ...command],
        {
          cwd: workdir,
          env: safeLaneEnvironment(this.orderlyHome),
          maxBuffer: 64 * 1024,
          windowsHide: true,
        },
        () => {},
      );
      child.stdin.on("error", () => {});
      const briefStream = createReadStream(join(laneDir, "brief.txt"));
      briefStream.on("error", () => child.stdin.destroy());
      briefStream.pipe(child.stdin);
      const pgidRaw = await waitForFile(`${stem}.pgid`);
      const pgid = Number.parseInt(pgidRaw || "", 10);
      if (!Number.isInteger(pgid) || pgid <= 1) throw new Error("lane wrapper did not report a process group");
      await this.registry.updateLane(lane.id, {
        state: "running",
        runtime: { ...this.registry.lane(lane.id).runtime, pgid, wrapper_pid: child.pid, group_alive: true },
      });
      await this.watcher.arm(lane.id);
    } catch (error) {
      await writeFile(logPath, `[orderly] broker start failure: ${error.message}\n`, { mode: 0o600 }).catch(() => {});
      if (!checkoutVerified) {
        const terminalRecord = {
          exit_code: 70,
          sweep_result: "broker-start-failed-before-worker",
          git_status_stable: true,
        };
        const harvest = await buildEmptyHarvest({
          laneDir,
          baseSha: lane.base_sha,
          briefPath: join(laneDir, "brief.txt"),
          terminalRecord,
        });
        await this.registry.updateLane(lane.id, {
          state: "terminal",
          terminal_class: "failed",
          terminal_record: terminalRecord,
          harvest,
          log_excerpt: `UNVERIFIED WORKER LOG EXCERPT\n[orderly] broker start failure: ${error.message}`,
          terminal_ts: new Date(this.now()).toISOString(),
        });
        return;
      }

      // Once a wrapper exists, only it may create .done. Ask it to exit, sweep
      // any PGID it managed to report, then let the watcher preserve evidence.
      child?.kill("SIGTERM");
      const pgidRaw = await waitForFile(`${stem}.pgid`, 1_000);
      const pgid = Number.parseInt(pgidRaw || "", 10);
      let sweep = { result: "broker-start-failed-no-process-group", alive: false };
      if (Number.isInteger(pgid) && pgid > 1) {
        sweep = await sweepProcessGroup(pgid, {
          alive: this.groupAlive,
          waitMs: this.sweepWaitMs,
          ...(this.signalGroup ? { signal: this.signalGroup } : {}),
        });
        await this.registry.updateLane(lane.id, {
          runtime: { ...this.registry.lane(lane.id).runtime, pgid, group_alive: sweep.alive },
        });
      }
      await waitForFile(`${stem}.done`, 5_000);
      await this.watcher.finalize(lane.id, {
        forcedClass: sweep.alive ? "process-unclean" : "failed",
        sweepResult: `broker-start-failed; ${sweep.result}`,
      });
    }
  }

  async cancel(id) {
    const lane = this.registry.lane(id);
    if (!lane) throw new BrokerRefused(404, "unknown lane id");
    if (lane.state === "terminal") return laneForApi(lane);
    if (lane.state === "proposed") {
      const terminalRecord = {
        exit_code: null,
        sweep_result: "cancelled-before-dispatch",
        git_status_stable: true,
      };
      const harvest = await buildEmptyHarvest({
        laneDir: this.registry.laneDir(id),
        baseSha: lane.base_sha,
        briefPath: join(this.registry.laneDir(id), "brief.txt"),
        terminalRecord,
      });
      await this.registry.updateLane(id, {
        state: "terminal",
        terminal_class: "no-op",
        terminal_record: terminalRecord,
        harvest,
        terminal_ts: new Date(this.now()).toISOString(),
        log_excerpt: "UNVERIFIED WORKER LOG EXCERPT\n(cancelled before dispatch)",
      });
      await this.startNext();
      return laneForApi(this.registry.lane(id));
    }
    await writeFile(lane.runtime.cancel_path, "operator-cancel\n", { mode: 0o600 });
    const sweep = await sweepProcessGroup(lane.runtime.pgid, {
      alive: this.groupAlive,
      waitMs: this.sweepWaitMs,
      ...(this.signalGroup ? { signal: this.signalGroup } : {}),
    });
    await waitForFile(lane.runtime.done_path, 5_000);
    await this.watcher.finalize(id, {
      forcedClass: sweep.alive ? "process-unclean" : "failed",
      sweepResult: `operator-cancel; ${sweep.result}`,
    });
    const deadline = Date.now() + 5_000;
    while (this.registry.lane(id).state !== "terminal" && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    if (this.registry.lane(id).state !== "terminal") {
      throw new BrokerRefused(503, "cancel sweep completed but terminal evidence is still pending");
    }
    return laneForApi(this.registry.lane(id));
  }

  async handle(req, res) {
    try {
      const url = new URL(req.url, "http://orderly-broker.invalid");
      const mutating = req.method === "POST";
      if (mutating) this.authenticate(req);

      if (req.method === "POST" && url.pathname === "/v1/dispatch/propose") {
        return sendJson(res, 200, await this.propose(await readJson(req)));
      }
      if (req.method === "POST" && url.pathname === "/v1/dispatch/confirm") {
        return sendJson(res, 200, await this.confirm(await readJson(req)));
      }
      if (req.method === "POST" && url.pathname === "/v1/seat/consult") {
        const result = await this.consult(await readJson(req));
        return sendJson(res, result.seat_failure ? 503 : 200, result);
      }
      if (req.method === "GET" && url.pathname === "/v1/lanes") {
        return sendJson(res, 200, this.registry.lanes().map(laneForApi));
      }
      if (req.method === "GET" && url.pathname === "/v1/allowlist") {
        // Ids and bounds only — paths and command templates stay host-side.
        return sendJson(res, 200, allowlistForApi(this.allowlist));
      }
      const laneMatch = url.pathname.match(/^\/v1\/lanes\/([A-Za-z0-9-]+)$/);
      if (req.method === "GET" && laneMatch) {
        const lane = this.registry.lane(laneMatch[1]);
        if (!lane) throw new BrokerRefused(404, "unknown lane id");
        return sendJson(res, 200, laneForApi(lane));
      }
      const cancelMatch = url.pathname.match(/^\/v1\/lanes\/([A-Za-z0-9-]+)\/cancel$/);
      if (req.method === "POST" && cancelMatch) {
        exactKeys(await readJson(req), [], "cancel request");
        return sendJson(res, 200, await this.cancel(cancelMatch[1]));
      }
      if (req.method === "POST" && url.pathname === "/v1/freeze") {
        exactKeys(await readJson(req), [], "freeze request");
        await this.registry.setFrozen(true);
        return sendJson(res, 200, { frozen: true });
      }
      throw new BrokerRefused(404, "unknown broker endpoint");
    } catch (error) {
      const status = error instanceof BrokerRefused ? error.status : 500;
      const message = error instanceof BrokerRefused ? error.message : "broker internal error";
      return sendJson(res, status, { error: message });
    }
  }
}

async function main() {
  const orderlyHome = process.env.ORDERLY_HOME || DEFAULT_HOME;
  if (process.argv[2] === "--unfreeze") {
    const registry = new LaneRegistry(join(orderlyHome, "lanes"));
    await registry.load();
    await registry.setFrozen(false);
    process.stdout.write("ORDERLY broker unfrozen at host\n");
    return;
  }
  const broker = new DispatchBroker({
    orderlyHome,
    allowlistPath: process.env.ORDERLY_ALLOWLIST || join(HERE, "allowlist.json5"),
  });
  await broker.listen();
  process.stdout.write(`ORDERLY broker listening on ${broker.socketPath}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`ORDERLY broker refused to start: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export { laneForApi, tokenMatches };
