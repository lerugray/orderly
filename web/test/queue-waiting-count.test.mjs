// The waiting count must reflect unanswered items, not the page size.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readQueue } from "../queue.mjs";

async function queueWith(draftCount, decisions = {}) {
  const dir = await mkdtemp(join(tmpdir(), "orderly-queue-"));
  const pendingPath = join(dir, "PENDING.md");
  const statePath = join(dir, "state.json");
  const lines = ["# PENDING", ""];
  for (let i = 1; i <= draftCount; i += 1) {
    lines.push(`- q-20260801-0900-${i} | chat | personal | p${i}@example.com | Draft number ${i}`);
  }
  await writeFile(pendingPath, `${lines.join("\n")}\n`);
  await writeFile(statePath, JSON.stringify({ v: 2, observed: [], decisions, results: {} }));
  return { pendingPath, statePath };
}

test("a heavy backlog is counted in full", async () => {
  // A fortnight of unanswered replies, none of them decided.
  const { pendingPath, statePath } = await queueWith(73);
  const queue = await readQueue({ pendingPath, statePath });
  assert.equal(
    queue.counts.pending,
    73,
    `73 drafts are unanswered and none has a decision recorded, but the queue reports ` +
      `${queue.counts.pending} waiting.`,
  );
});

test("an ordinary day is counted and shown in full", async () => {
  const { pendingPath, statePath } = await queueWith(5);
  const queue = await readQueue({ pendingPath, statePath });
  assert.equal(queue.counts.pending, 5, "a five-draft queue must report five waiting");
  assert.equal(queue.pending.length, 5, "a five-draft queue must show five cards");
});

test("answered drafts leave the waiting set and are counted as decided", async () => {
  const { pendingPath, statePath } = await queueWith(5, {
    "q-20260801-0900-2": { decision: "approved", at: "2026-08-01T13:00:00.000Z" },
    "q-20260801-0900-4": { decision: "discarded", at: "2026-08-01T13:05:00.000Z" },
  });
  const queue = await readQueue({ pendingPath, statePath });
  assert.equal(queue.counts.pending, 3, "two of five were answered, so three are waiting");
  assert.equal(queue.counts.approved, 1);
  assert.equal(queue.counts.discarded, 1);
  assert.ok(!queue.pending.some((item) => item.id === "q-20260801-0900-2"));
});
