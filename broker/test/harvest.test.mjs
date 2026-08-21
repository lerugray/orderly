import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildHarvest, sha256File } from "../harvest.mjs";
import { fixtureRepo } from "./helpers.mjs";

const runFile = promisify(execFile);

test("harvest hashes patch bytes, inventories untracked files, and preserves the tree", async (t) => {
  const fixture = await fixtureRepo();
  t.after(fixture.cleanup);
  const laneDir = join(fixture.root, "lane");
  const workdir = join(laneDir, "worktree");
  await mkdir(laneDir, { recursive: true });
  await runFile("git", ["clone", "--quiet", fixture.repo, workdir]);
  await writeFile(join(workdir, "tracked.txt"), "base\nchanged\n");
  const untrackedBody = "preserve me\n";
  await writeFile(join(workdir, "new file.txt"), untrackedBody);
  const hostileGitHelper = join(workdir, "hostile-git-helper.sh");
  await writeFile(hostileGitHelper, "#!/bin/sh\ntouch HOST_GIT_CONFIG_EXECUTED\nexit 0\n");
  await chmod(hostileGitHelper, 0o755);
  await runFile("git", ["config", "core.fsmonitor", hostileGitHelper], { cwd: workdir });
  await runFile("git", ["config", "diff.external", hostileGitHelper], { cwd: workdir });
  const briefPath = join(laneDir, "brief.txt");
  await writeFile(briefPath, "Do the fixture work.\n");
  const terminalRecord = { exit_code: 0, sweep_result: "group-already-dead", git_status_stable: true };

  const harvest = await buildHarvest({ laneDir, workdir, baseSha: fixture.sha, briefPath, terminalRecord });
  assert.equal(harvest.patch_sha256, await sha256File(harvest.patch_path));
  assert.match(await readFile(harvest.patch_path, "utf8"), /\+changed/);
  assert.match(harvest.diffstat, /tracked\.txt/);
  assert.deepEqual(
    harvest.untracked_inventory.find((entry) => entry.path === "new file.txt"),
    {
      path: "new file.txt",
      size: Buffer.byteLength(untrackedBody),
      sha256: createHash("sha256").update(untrackedBody).digest("hex"),
    },
  );
  assert.equal(
    await stat(join(workdir, "HOST_GIT_CONFIG_EXECUTED")).then(() => true, () => false),
    false,
  );
  assert.equal(await readFile(join(laneDir, "harvest", "brief.txt"), "utf8"), "Do the fixture work.\n");
  assert.deepEqual(JSON.parse(await readFile(join(laneDir, "harvest", "terminal-record.json"), "utf8")), terminalRecord);
  assert.equal((await stat(join(workdir, "new file.txt"))).isFile(), true);
  assert.equal(await readFile(join(workdir, "tracked.txt"), "utf8"), "base\nchanged\n");
});
