// ORDERLY sentinel watcher — kernel state and repository bytes outrank prose.
//
// A .done file says the wrapper attempted its sweep. It does not say the
// command succeeded, changed anything, or even managed to kill its process
// group. This watcher establishes each of those facts independently.

import { execFile as runFile } from "node:child_process";
import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildHarvest, gitStatus } from "./harvest.mjs";

const runFileAsync = promisify(runFile);
const DEFAULT_STALL_MS = 20 * 60 * 1000;
const DEFAULT_POLL_MS = 2_000;
const DEFAULT_STABILITY_MS = 3_000;
const EXCERPT_BYTES = 8 * 1024;
const EXCERPT_CHARS = 4_000;

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function isProcessGroupAlive(pgid) {
  if (!Number.isInteger(Number(pgid)) || Number(pgid) <= 1) return false;
  try {
    await runFileAsync("pgrep", ["-g", String(pgid)], {
      timeout: 2_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    return true;
  } catch (error) {
    if (error?.code === 1 || error?.exitCode === 1) return false;
    // pgrep reports "no matches" with status 1. Any other failure is not
    // evidence of death, so fail closed and keep the lane blocking the board.
    return true;
  }
}

function signalGroup(pgid, signal) {
  try {
    process.kill(-Number(pgid), signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export async function sweepProcessGroup(
  pgid,
  { waitMs = 2_000, alive = isProcessGroupAlive, signal = signalGroup } = {},
) {
  if (!(await alive(pgid))) return { result: "group-already-dead", alive: false };
  signal(pgid, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  if (!(await alive(pgid))) return { result: "term-swept", alive: false };
  signal(pgid, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  const stillAlive = await alive(pgid);
  return { result: stillAlive ? "group-still-live-after-kill" : "kill-swept", alive: stillAlive };
}

export function classifyTerminal({ groupWasAlive, groupAlive, exitCode, timedOut, gitChanged, stalled }) {
  if (stalled) return "failed";
  if (groupWasAlive || groupAlive || exitCode === null) return "process-unclean";
  if (timedOut || exitCode === 124) return "timed-out";
  if (exitCode !== 0) return "failed";
  return gitChanged ? "exit-zero" : "no-op";
}

async function numberFrom(path) {
  try {
    const value = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
    return Number.isInteger(value) ? value : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function textFrom(path, fallback) {
  try {
    return (await readFile(path, "utf8")).trim() || fallback;
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function logExcerpt(path) {
  try {
    const info = await stat(path);
    const length = Math.min(info.size, EXCERPT_BYTES);
    const handle = await open(path, "r");
    const buffer = Buffer.alloc(length);
    try {
      await handle.read(buffer, 0, length, Math.max(0, info.size - length));
    } finally {
      await handle.close();
    }
    const clean = buffer
      .toString("utf8")
      .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
      .replace(
        /(["']?(?:api[-_]?key|token|authorization|password|secret)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
        "$1[REDACTED]",
      )
      .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED]")
      .slice(-EXCERPT_CHARS);
    return `UNVERIFIED WORKER LOG EXCERPT\n${clean}`;
  } catch (error) {
    if (error?.code === "ENOENT") return "UNVERIFIED WORKER LOG EXCERPT\n(no log was written)";
    throw error;
  }
}

export class LaneWatcher {
  constructor({
    registry,
    onTerminal = async () => {},
    pollMs = DEFAULT_POLL_MS,
    stallMs = DEFAULT_STALL_MS,
    stabilityMs = DEFAULT_STABILITY_MS,
    alive = isProcessGroupAlive,
    now = () => Date.now(),
  }) {
    this.registry = registry;
    this.onTerminal = onTerminal;
    this.pollMs = pollMs;
    this.stallMs = stallMs;
    this.stabilityMs = stabilityMs;
    this.alive = alive;
    this.now = now;
    this.watches = new Map();
    this.finishing = new Set();
  }

  async arm(id) {
    if (this.watches.has(id)) return;
    const lane = this.registry.lane(id);
    if (!lane || lane.state === "terminal") return;
    const logPath = lane.runtime.log_path;
    const size = await stat(logPath).then((value) => value.size, () => 0);
    const watch = { size, changedAt: this.now(), timer: null };
    const tick = async () => {
      try {
        await this.check(id, watch);
      } catch (error) {
        // Watch failures remain operator-visible and are retried. They never
        // manufacture a clean terminal record from missing evidence.
        await this.registry.updateLane(id, {
          log_excerpt: `UNVERIFIED WORKER LOG EXCERPT\nwatcher error: ${error.message}`,
        }).catch(() => {});
      }
    };
    watch.timer = setInterval(tick, this.pollMs);
    watch.timer.unref?.();
    this.watches.set(id, watch);
    await tick();
  }

  disarm(id) {
    const watch = this.watches.get(id);
    if (watch) clearInterval(watch.timer);
    this.watches.delete(id);
  }

  close() {
    for (const id of this.watches.keys()) this.disarm(id);
  }

  async check(id, watch = this.watches.get(id)) {
    const lane = this.registry.lane(id);
    if (!lane || lane.state === "terminal" || this.finishing.has(id)) return;
    const done = lane.runtime.done_path;
    if (await exists(done)) {
      await this.finalize(id);
      return;
    }
    const size = await stat(lane.runtime.log_path).then((value) => value.size, () => 0);
    if (size !== watch.size) {
      watch.size = size;
      watch.changedAt = this.now();
      return;
    }
    if (this.now() - watch.changedAt < this.stallMs) return;
    if (!(await this.alive(lane.runtime.pgid))) await this.finalize(id, { stalled: true });
  }

  async finalize(id, { stalled = false, forcedClass = null, sweepResult = null } = {}) {
    if (this.finishing.has(id)) return;
    const lane = this.registry.lane(id);
    if (!lane || lane.state === "terminal") return;
    this.finishing.add(id);
    this.disarm(id);
    try {
      const pgid = lane.runtime.pgid;
      const groupWasAlive = await this.alive(pgid);
      const wrapperSweep = lane.runtime.sweep_path
        ? await textFrom(lane.runtime.sweep_path, "wrapper-sweep-result-missing")
        : "wrapper-sweep-result-missing";
      let sweep = { result: sweepResult || wrapperSweep, alive: false };
      if (groupWasAlive) sweep = await sweepProcessGroup(pgid, { alive: this.alive });

      const firstStatus = await gitStatus(lane.runtime.workdir);
      await new Promise((resolve) => setTimeout(resolve, this.stabilityMs));
      const secondStatus = await gitStatus(lane.runtime.workdir);
      const stable = firstStatus === secondStatus;
      const exitCode = await numberFrom(lane.runtime.exit_path);
      const timedOut = await exists(lane.runtime.timeout_path);
      const cancelled = lane.runtime.cancel_path ? await exists(lane.runtime.cancel_path) : false;
      const terminalClass = forcedClass || (cancelled && !sweep.alive
        ? "failed"
        : classifyTerminal({
            groupWasAlive,
            groupAlive: sweep.alive,
            exitCode,
            timedOut,
            gitChanged: secondStatus.length > 0,
            stalled,
          }));
      const terminalRecord = {
        exit_code: exitCode,
        sweep_result: stalled
          ? `stall-detected; ${sweep.result}`
          : cancelled && !String(sweep.result).startsWith("operator-cancel")
            ? `operator-cancel; ${sweep.result}`
            : sweep.result,
        git_status_stable: stable,
      };
      const briefPath = join(this.registry.laneDir(id), "brief.txt");
      const harvest = await buildHarvest({
        laneDir: this.registry.laneDir(id),
        workdir: lane.runtime.workdir,
        baseSha: lane.base_sha,
        briefPath,
        terminalRecord,
      });
      await this.registry.updateLane(id, {
        state: "terminal",
        terminal_class: terminalClass,
        terminal_record: terminalRecord,
        harvest,
        log_excerpt: await logExcerpt(lane.runtime.log_path),
        terminal_ts: new Date(this.now()).toISOString(),
        runtime: { ...lane.runtime, group_alive: sweep.alive },
      });
      await this.onTerminal(this.registry.lane(id));
    } finally {
      this.finishing.delete(id);
    }
  }

  // Reconciliation already classified the missing process. This completes the
  // evidence and preservation packet without overwriting that class.
  async completeReconciled(id) {
    const lane = this.registry.lane(id);
    if (!lane || lane.terminal_class !== "process-unclean" || lane.harvest) return;
    const firstStatus = await gitStatus(lane.runtime.workdir);
    await new Promise((resolve) => setTimeout(resolve, this.stabilityMs));
    const secondStatus = await gitStatus(lane.runtime.workdir);
    const record = { ...lane.terminal_record, git_status_stable: firstStatus === secondStatus };
    const harvest = await buildHarvest({
      laneDir: this.registry.laneDir(id),
      workdir: lane.runtime.workdir,
      baseSha: lane.base_sha,
      briefPath: join(this.registry.laneDir(id), "brief.txt"),
      terminalRecord: record,
    });
    await this.registry.updateLane(id, {
      terminal_record: record,
      harvest,
      log_excerpt: await logExcerpt(lane.runtime.log_path),
    });
  }
}
