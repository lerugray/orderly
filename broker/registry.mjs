// ORDERLY lane registry — the durable, broker-owned account of what ran.
//
// The JSON file is deliberately boring. A replacement is completely written
// and fsync'd before rename, and the containing directory is fsync'd after it.
// A power loss may therefore leave the old file or the new file, never a
// half-written registry which invites a second execution.

import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const EMPTY = Object.freeze({ version: 1, frozen: false, proposals: {}, lanes: {} });

function freshRegistry() {
  return { version: EMPTY.version, frozen: false, proposals: {}, lanes: {} };
}

export async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export class LaneRegistry {
  constructor(root) {
    this.root = root;
    this.path = join(root, "registry.json");
    this.data = freshRegistry();
    this.writeChain = Promise.resolve();
  }

  async load() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      if (parsed?.version !== 1 || !parsed.proposals || !parsed.lanes) {
        throw new Error("registry schema is not version 1");
      }
      this.data = parsed;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.data = freshRegistry();
      await this.save();
    }
    return this.data;
  }

  save() {
    // Every mutation is serialized through one promise. Callers can update
    // separate lanes concurrently without allowing an older snapshot to land
    // after a newer one.
    const snapshot = structuredClone(this.data);
    // The chain orders writes; it must not carry their outcome forward. A plain
    // .then() stays rejected after one failure, so every later save skips the
    // write while memory keeps advancing. Each caller still gets its own result.
    const next = this.writeChain.then(
      () => atomicWriteJson(this.path, snapshot),
      () => atomicWriteJson(this.path, snapshot),
    );
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  laneDir(id) {
    return join(this.root, id);
  }

  async putProposal(proposal) {
    this.data.proposals[proposal.proposal_id] = structuredClone(proposal);
    await this.save();
  }

  proposal(id) {
    return this.data.proposals[id] ?? null;
  }

  async putLane(lane) {
    this.data.lanes[lane.id] = structuredClone(lane);
    await mkdir(this.laneDir(lane.id), { recursive: true, mode: 0o700 });
    await this.save();
  }

  lane(id) {
    return this.data.lanes[id] ?? null;
  }

  lanes() {
    return Object.values(this.data.lanes).sort((a, b) => a.created_ts.localeCompare(b.created_ts));
  }

  async updateLane(id, change) {
    const lane = this.lane(id);
    if (!lane) throw new Error(`unknown lane ${id}`);
    Object.assign(lane, typeof change === "function" ? change(structuredClone(lane)) : change);
    await this.save();
    return lane;
  }

  // Lane creation and the proposal replay key must reach disk in one atomic
  // snapshot. If the broker dies after brief.txt but before this save, the
  // orphan directory is inert; if this save lands, every replay sees lane_id.
  async confirmProposal(proposalId, lane, confirmedTs = new Date().toISOString()) {
    const proposal = this.proposal(proposalId);
    if (!proposal) throw new Error(`unknown proposal ${proposalId}`);
    if (proposal.lane_id) return this.lane(proposal.lane_id);
    await mkdir(this.laneDir(lane.id), { recursive: true, mode: 0o700 });
    this.data.lanes[lane.id] = structuredClone(lane);
    proposal.lane_id = lane.id;
    proposal.confirmed_ts = confirmedTs;
    await this.save();
    return this.lane(lane.id);
  }

  async setFrozen(frozen) {
    this.data.frozen = Boolean(frozen);
    await this.save();
  }

  activeLane() {
    return this.lanes().find((lane) => lane.state === "dispatched" || lane.state === "running") ?? null;
  }

  queuedLane() {
    return this.lanes().find((lane) => lane.state === "proposed") ?? null;
  }

  // A running record is only a claim after restart. Reconciliation asks the
  // kernel about the recorded process group, marks dead claims unclean, and
  // returns live lanes so the broker can re-arm their watchers.
  async reconcile(isGroupAlive, now = () => new Date().toISOString()) {
    const live = [];
    const dead = [];
    for (const lane of this.lanes()) {
      if (lane.state !== "running" && lane.state !== "dispatched") continue;
      const pgid = lane.runtime?.pgid;
      if (Number.isInteger(pgid) && pgid > 1 && (await isGroupAlive(pgid))) {
        live.push(lane.id);
        continue;
      }
      lane.state = "terminal";
      lane.terminal_class = "process-unclean";
      lane.terminal_record = {
        exit_code: null,
        sweep_result: "process-group-absent-on-boot",
        git_status_stable: false,
      };
      lane.terminal_ts = now();
      dead.push(lane.id);
    }
    if (dead.length) await this.save();
    return { live, dead };
  }
}
