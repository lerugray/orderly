// Every item counted as waiting must be answerable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeDraft, readQueue, decide } from "../queue.mjs";

async function bench(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const pendingPath = join(dir, "PENDING.md");
  const statePath = join(dir, "state.json");
  await writeFile(pendingPath, "# PENDING\n");
  await writeFile(statePath, JSON.stringify({ v: 2, observed: [], decisions: {}, results: {} }));
  return { pendingPath, statePath };
}
const note = (i) => ({ subject: `Note ${i}`, to: `p${i}@example.com`, account: "personal" });

test("a backlog can be cleared from the oldest end", async () => {
  const { pendingPath, statePath } = await bench("orderly-reach-");
  const ids = [];
  for (let i = 1; i <= 150; i += 1) ids.push(await observeDraft({ statePath, card: note(i), desk: "coordinator" }));
  const queue = await readQueue({ pendingPath, statePath });
  const outcome = await decide({ pendingPath, statePath, id: ids[0], decision: "approve" })
    .then(() => "answered", (error) => `refused: ${error.message}`);
  assert.equal(
    outcome,
    "answered",
    `the queue reports ${queue.counts.pending} waiting but returned ${queue.pending.length}, ` +
      `and answering the oldest gave "${outcome}". It has never been decided.`,
  );
});

test("answering behaves normally, and answering twice is refused", async () => {
  const { pendingPath, statePath } = await bench("orderly-reach-one-");
  const id = await observeDraft({ statePath, card: note(1), desk: "coordinator" });
  const result = await decide({ pendingPath, statePath, id, decision: "approve" });
  assert.equal(result.decision, "approved");
  await assert.rejects(
    () => decide({ pendingPath, statePath, id, decision: "approve" }),
    "answering the same card twice must be refused",
  );
});
