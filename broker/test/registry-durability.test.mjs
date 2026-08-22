// A failed write must not stop later writes from reaching disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LaneRegistry } from "../registry.mjs";

const proposal = (id) => ({ proposal_id: id, brief_hash: `h-${id}` });

// These make a directory unwritable to provoke a write failure. Root bypasses
// permission bits, so under root they would fail for an unrelated reason.
const skipRoot = typeof process.getuid === "function" && process.getuid() === 0
  ? "needs a non-root user: root ignores permission bits"
  : false;

async function registryIn(prefix) {
  const root = join(await mkdtemp(join(tmpdir(), prefix)), "lanes");
  const registry = new LaneRegistry(root);
  await registry.load();
  return { registry, root };
}

test("a brief storage fault does not end record keeping", { skip: skipRoot }, async () => {
  const { registry, root } = await registryIn("orderly-registry-");
  await registry.putProposal(proposal("job-A"));

  await chmod(root, 0o500);
  await assert.rejects(() => registry.putProposal(proposal("job-B")));
  await chmod(root, 0o700);

  const outcome = await registry.putProposal(proposal("job-C"))
    .then(() => "persisted", (error) => `refused: ${error?.code ?? error?.message}`);
  assert.equal(
    outcome,
    "persisted",
    `the directory takes writes again, so the next save must succeed; it returned "${outcome}".`,
  );
  const onDisk = Object.keys(JSON.parse(await readFile(registry.path, "utf8")).proposals);
  assert.ok(
    onDisk.includes("job-C"),
    `the directory takes writes again and the registry holds ` +
      `${JSON.stringify(Object.keys(registry.data.proposals))} in memory, but only ` +
      `${JSON.stringify(onDisk)} reached disk; the save after the fault returned "${outcome}".`,
  );
});

test("ordinary saves persist, and an impossible save still reports failure", { skip: skipRoot }, async () => {
  const healthy = await registryIn("orderly-registry-ok-");
  for (const id of ["job-1", "job-2", "job-3"]) await healthy.registry.putProposal(proposal(id));
  const onDisk = Object.keys(JSON.parse(await readFile(healthy.registry.path, "utf8")).proposals);
  assert.deepEqual(onDisk.sort(), ["job-1", "job-2", "job-3"], "every healthy save must reach disk");

  const blocked = await registryIn("orderly-registry-ro-");
  await chmod(blocked.root, 0o500);
  await assert.rejects(
    () => blocked.registry.putProposal(proposal("job-x")),
    "a write that cannot happen must not resolve as though it did",
  );
  await chmod(blocked.root, 0o700);
});
