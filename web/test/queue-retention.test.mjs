// Prefer retaining unanswered cards when pruning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
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

test("a long-running station keeps the work it has not dealt with", async () => {
  const { pendingPath, statePath } = await bench("orderly-retention-");
  const ids = [];
  for (let i = 1; i <= 200; i += 1) ids.push(await observeDraft({ statePath, card: note(i), desk: "coordinator" }));

  // Half a working week of replies get dealt with.
  const answered = ids.slice(-50);
  for (const id of answered) await decide({ pendingPath, statePath, id, decision: "discard" });

  // The next morning's arrivals push storage past its limit.
  const oldestUnanswered = ids.slice(0, 20);
  for (let i = 201; i <= 220; i += 1) await observeDraft({ statePath, card: note(i), desk: "coordinator" });

  const stored = JSON.parse(await readFile(statePath, "utf8")).observed.map((item) => item.id);
  const answeredKept = answered.filter((id) => stored.includes(id)).length;
  const lost = oldestUnanswered.filter((id) => !stored.includes(id)).length;
  assert.equal(
    lost,
    0,
    `the store dropped ${lost} card(s) that were never answered while still holding ` +
      `${answeredKept} that were. A card seen in chat carries its own draft text and has no ` +
      `PENDING.md line behind it.`,
  );
});

test("a quiet station keeps everything, and a busy one stays bounded", async () => {
  const small = await bench("orderly-retention-small-");
  for (let i = 1; i <= 5; i += 1) await observeDraft({ statePath: small.statePath, card: note(i), desk: "coordinator" });
  assert.equal((await readQueue(small)).counts.pending, 5, "five observed drafts must all be waiting");

  const big = await bench("orderly-retention-cap-");
  for (let i = 1; i <= 260; i += 1) await observeDraft({ statePath: big.statePath, card: note(i), desk: "coordinator" });
  const stored = JSON.parse(await readFile(big.statePath, "utf8")).observed;
  assert.ok(stored.length <= 200, `the store must stay bounded, holds ${stored.length}`);
});
