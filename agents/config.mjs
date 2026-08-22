// Gateway-owned, atomic edits for the derived OpenClaw named-agent entries.

import { execFile as execFileCallback } from "node:child_process";
import { copyFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, dirname, join } from "node:path";

import { namedIsolatedProfile } from "./profile.mjs";

const execFile = promisify(execFileCallback);

export class AgentConfigRefused extends Error {}
const refuse = (message) => { throw new AgentConfigRefused(message); };

function assertGuard(config) {
  if (config?.agents?.defaults?.sandbox?.mode !== "all") refuse("The gateway sandbox default must remain all.");
  if ((config?.agents?.defaults?.sandbox?.backend ?? "docker") !== "docker") refuse("The named-isolated profile requires the Docker backend.");
  if (config?.agents?.defaults?.sandbox?.scope === "shared") refuse("A shared sandbox scope cannot host named agents.");
  if (config?.tools?.elevated?.enabled !== false) refuse("Elevated tools must remain disabled.");
  if (!Array.isArray(config?.agents?.list)) refuse("The gateway agent list is missing.");
  return config;
}

export async function readGatewayConfig(configPath) {
  let parsed;
  try { parsed = JSON.parse(await readFile(configPath, "utf8")); }
  catch { refuse("The gateway config is not readable as JSON. Nothing was changed."); }
  return assertGuard(parsed);
}

async function defaultValidate({ candidatePath, openclawBin = "openclaw" }) {
  try {
    await execFile(openclawBin, ["config", "validate"], {
      env: { ...process.env, OPENCLAW_CONFIG_PATH: candidatePath },
      timeout: 30_000,
      maxBuffer: 256 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

async function pruneBackups(configPath, keep = 12) {
  const prefix = `${basename(configPath)}.orderly-agents-bak-`;
  const files = (await readdir(dirname(configPath)).catch(() => []))
    .filter((name) => name.startsWith(prefix)).sort();
  for (const name of files.slice(0, Math.max(0, files.length - keep))) {
    await unlink(join(dirname(configPath), name)).catch(() => {});
  }
}

export async function writeAgentEntry({
  configPath,
  root,
  record,
  remove = false,
  validate = defaultValidate,
  openclawBin = "openclaw",
}) {
  const lockPath = `${configPath}.orderly-agents.lock`;
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if (error?.code === "EEXIST") refuse("Another gateway agent update is in progress.");
    throw error;
  }
  try {
    const beforeText = await readFile(configPath, "utf8");
    const before = assertGuard(JSON.parse(beforeText));
    const existing = before.agents.list.findIndex((entry) => entry?.id === record.id);
    const next = structuredClone(before);
    if (remove) {
      if (existing >= 0) next.agents.list.splice(existing, 1);
    } else {
      const derived = namedIsolatedProfile({ root, record });
      if (record.memoryPolicy === "persistent") {
        await mkdir(join(derived.workspace, ".openclaw", "sandbox-skills", "skills"), { recursive: true, mode: 0o700 });
      }
      if (existing >= 0) next.agents.list[existing] = derived;
      else next.agents.list.push(derived);
    }
    assertGuard(next);

    // Refuse collisions with the reserved singleton profiles and duplicate ids.
    const ids = next.agents.list.map((entry) => entry?.id);
    if (new Set(ids).size !== ids.length) refuse("The gateway agent list contains duplicate identities.");
    for (const entry of next.agents.list) {
      if (entry?.id === record.id && !remove && entry?.sandbox?.docker?.network !== "none") {
        refuse("A named agent cannot gain network access.");
      }
    }

    if (JSON.stringify(before) === JSON.stringify(next)) return { changed: false, entry: remove ? null : next.agents.list[existing] };

    const dir = dirname(configPath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.${basename(configPath)}.agents-${process.pid}-${Date.now()}`);
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    const handle = await open(tmp, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    if (!(await validate({ candidatePath: tmp, openclawBin }))) {
      await unlink(tmp).catch(() => {});
      refuse("OpenClaw did not validate the derived named-agent config. Nothing was changed.");
    }
    if ((await readFile(configPath, "utf8")) !== beforeText) {
      await unlink(tmp).catch(() => {});
      refuse("The gateway config changed during the update. Review and retry.");
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    if (await stat(configPath).catch(() => null)) await copyFile(configPath, `${configPath}.orderly-agents-bak-${stamp}`);
    await rename(tmp, configPath);
    await pruneBackups(configPath);
    return { changed: true, entry: remove ? null : namedIsolatedProfile({ root, record }) };
  } catch (error) {
    if (error instanceof AgentConfigRefused) throw error;
    refuse("The gateway agent update failed. Nothing was activated.");
  } finally {
    await lock?.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}
