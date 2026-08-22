import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, observeDraft, observeProposal, readQueue } from "../queue.mjs";

const FROM = "2026-08-25T14:00:00-04:00";
const TO = "2026-08-25T15:00:00-04:00";

async function bench(prefix, pending) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const pendingPath = join(dir, "PENDING.md");
  const statePath = join(dir, "state.json");
  await writeFile(pendingPath, pending);
  await writeFile(statePath, JSON.stringify({ v: 2, observed: [], decisions: {}, results: {} }));
  return { pendingPath, statePath };
}

const eventLine = (id, summary = "Budget review") =>
  `- ${id} | create | chat | personal | ${summary} | ${FROM} | ${TO} | - | cfo@example.com | asked\n`;

test("an executed file-backed effect stays completed after aliases and recent decisions are pruned", async () => {
  const fileId = "e-20260825-0900-1";
  const paths = await bench("orderly-completion-", eventLine(fileId));
  const observedId = await observeProposal({
    statePath: paths.statePath,
    desk: "coordinator",
    card: {
      action: "create", account: "personal", summary: "Budget review",
      from: FROM, to: TO, attendees: ["cfo@example.com"], location: "Board room",
    },
  });
  assert.equal((await readQueue(paths)).pending[0].id, observedId,
    "the detailed observed alias should be the card the operator answers");

  let executions = 0;
  await decide({ ...paths, id: observedId, decision: "approve", execute: async () => {
    executions += 1;
    return { eventId: "created-1", action: "create", account: "personal" };
  } });

  // Model the two independent retention paths: the observed alias has left its
  // bounded store, and enough newer decisions exist to evict its id record.
  const state = JSON.parse(await readFile(paths.statePath, "utf8"));
  state.observed = [];
  state.decisions[observedId].at = "2000-01-01T00:00:00.000Z";
  for (let i = 0; i < 801; i += 1) {
    state.decisions[`w-newer-${i}`] = { decision: "discarded", at: `2020-01-01T00:${String(i % 60).padStart(2, "0")}:00.000Z` };
  }
  await writeFile(paths.statePath, JSON.stringify(state));
  await observeDraft({
    statePath: paths.statePath,
    desk: "coordinator",
    card: { subject: "new work", to: "person@example.com", account: "personal" },
  });
  const trigger = (await readQueue(paths)).pending.find((item) => item.type === "draft");
  await decide({ ...paths, id: trigger.id, decision: "discard" });

  const stored = JSON.parse(await readFile(paths.statePath, "utf8"));
  assert.equal(stored.decisions[observedId], undefined, "the ordinary id decision must really have expired");
  assert.equal(Object.keys(stored.completions ?? {}).length, 2,
    "the exact observed effect and its file-safe alias must remain durable");
  const queue = await readQueue(paths);
  assert.equal(queue.pending.some((item) => item.id === fileId), false,
    "the append-only file alias must not resurrect the executed event");
  await assert.rejects(
    () => decide({ ...paths, id: fileId, decision: "approve", execute: async () => { executions += 1; } }),
    /isn't waiting any more/,
  );
  assert.equal(executions, 1, "the calendar effect must execute exactly once");

  await writeFile(paths.statePath, "{not-json");
  await assert.rejects(() => readQueue(paths), /decision store is corrupt/,
    "losing durable completion state must fail closed instead of re-offering effects");
});

test("an oversized append-only source fails closed at a fixed read bound", async () => {
  const paths = await bench("orderly-bounded-", "x".repeat(1024 * 1024 + 1));
  await assert.rejects(() => readQueue(paths), /safe read limit/);
});

test("duplicate accepted ids cannot be paged or approved ambiguously", async () => {
  const id = "e-20260825-0900-1";
  const paths = await bench(
    "orderly-duplicate-id-",
    eventLine(id, "Budget review") + eventLine(id, "Hiring review"),
  );
  await assert.rejects(() => readQueue(paths), /duplicate card ids/);
  let executions = 0;
  await assert.rejects(
    () => decide({ ...paths, id, decision: "approve", execute: async () => { executions += 1; } }),
    /duplicate card ids/,
  );
  assert.equal(executions, 0, "an ambiguous id must never reach the calendar executor");
});
