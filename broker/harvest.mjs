// ORDERLY harvest packets preserve lane work before anyone interprets it.
// Nothing in this module resets, cleans, stages, commits, merges or pushes.

import { createHash } from "node:crypto";
import { execFile as runFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readlink, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { atomicWriteJson } from "./registry.mjs";

const runFileAsync = promisify(runFile);
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
const GIT_ENV = {
  PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
  HOME: "/nonexistent",
  LANG: process.env.LANG || "C.UTF-8",
  LC_ALL: process.env.LC_ALL || "C.UTF-8",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
const SAFE_GIT_CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.hooksPath=/dev/null",
];

async function git(workdir, args, encoding = "utf8") {
  const { stdout } = await runFileAsync("git", [...SAFE_GIT_CONFIG, ...args], {
    cwd: workdir,
    encoding,
    env: GIT_ENV,
    maxBuffer: MAX_GIT_OUTPUT,
    timeout: 60_000,
    windowsHide: true,
  });
  return stdout;
}

async function gitToFile(workdir, args, outputPath) {
  await runFileAsync(
    "git",
    [...SAFE_GIT_CONFIG, args[0], `--output=${outputPath}`, ...args.slice(1)],
    {
      cwd: workdir,
      env: GIT_ENV,
      maxBuffer: 1024 * 1024,
      timeout: 5 * 60_000,
      windowsHide: true,
    },
  );
  await chmod(outputPath, 0o600);
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function inventoryEntry(workdir, relative) {
  const path = join(workdir, relative);
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    const target = await readlink(path);
    return {
      path: relative,
      size: Buffer.byteLength(target),
      sha256: createHash("sha256").update(target).digest("hex"),
    };
  }
  if (!info.isFile()) return { path: relative, size: info.size, sha256: null };
  return { path: relative, size: info.size, sha256: await sha256File(path) };
}

export async function gitStatus(workdir) {
  return String(await git(workdir, ["status", "--porcelain=v1", "--untracked-files=all"]));
}

export async function buildHarvest({ laneDir, workdir, baseSha, briefPath, terminalRecord }) {
  const harvestDir = join(laneDir, "harvest");
  await mkdir(harvestDir, { recursive: true, mode: 0o700 });

  // Patch bytes are written first and named by their content hash. Even an
  // empty patch is an artifact with an independently checkable digest.
  const patchTemporary = join(harvestDir, `patch.tmp-${process.pid}-${Date.now()}`);
  await gitToFile(
    workdir,
    ["diff", "--no-ext-diff", "--no-textconv", "--binary", baseSha, "--"],
    patchTemporary,
  );
  const patchHash = await sha256File(patchTemporary);
  const patchPath = join(harvestDir, `patch-${patchHash}.diff`);
  await rename(patchTemporary, patchPath);

  const rawUntracked = await git(workdir, ["ls-files", "--others", "--exclude-standard", "-z"], "buffer");
  const paths = Buffer.from(rawUntracked)
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
  const untrackedInventory = [];
  for (const path of paths) untrackedInventory.push(await inventoryEntry(workdir, path));

  const diffstat = String(
    await git(workdir, ["diff", "--no-ext-diff", "--no-textconv", "--stat", baseSha, "--"]),
  );
  const briefCopy = join(harvestDir, "brief.txt");
  await copyFile(briefPath, briefCopy);
  const terminalPath = join(harvestDir, "terminal-record.json");
  await atomicWriteJson(terminalPath, terminalRecord);

  const harvest = {
    patch_sha256: patchHash,
    patch_path: patchPath,
    untracked_inventory: untrackedInventory,
    diffstat,
  };
  await atomicWriteJson(join(harvestDir, "packet.json"), {
    base_sha: baseSha,
    brief_path: basename(briefCopy),
    terminal_record: terminalRecord,
    harvest,
  });
  return harvest;
}

// A queued lane can be cancelled before a worktree or process exists. It still
// gets a complete preservation packet: an empty, hashed patch and its brief,
// rather than a terminal record whose harvest fields mysteriously disappear.
export async function buildEmptyHarvest({ laneDir, baseSha, briefPath, terminalRecord }) {
  const harvestDir = join(laneDir, "harvest");
  await mkdir(harvestDir, { recursive: true, mode: 0o700 });
  const patchHash = createHash("sha256").update("").digest("hex");
  const patchPath = join(harvestDir, `patch-${patchHash}.diff`);
  await writeFile(patchPath, "", { mode: 0o600 });
  await copyFile(briefPath, join(harvestDir, "brief.txt"));
  await atomicWriteJson(join(harvestDir, "terminal-record.json"), terminalRecord);
  const harvest = {
    patch_sha256: patchHash,
    patch_path: patchPath,
    untracked_inventory: [],
    diffstat: "",
  };
  await atomicWriteJson(join(harvestDir, "packet.json"), {
    base_sha: baseSha,
    brief_path: "brief.txt",
    terminal_record: terminalRecord,
    harvest,
  });
  return harvest;
}

export { sha256File };
