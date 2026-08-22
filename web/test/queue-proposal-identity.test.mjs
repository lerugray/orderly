// Proposals with different attendees, or different update targets, are
// different proposals. An event id a create never sends is not one of those.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readQueue, observeProposal, observeDraft } from "../queue.mjs";

const FROM = "2026-08-25T14:00:00-04:00";
const TO = "2026-08-25T15:00:00-04:00";

async function bench(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const pendingPath = join(dir, "PENDING.md");
  const statePath = join(dir, "state.json");
  await writeFile(statePath, JSON.stringify({ v: 2, observed: [], decisions: {}, results: {} }));
  return { pendingPath, statePath };
}

const logged = (guests) =>
  `- e-20260825-0900-1 | create | chat | personal | Budget review | ${FROM} | ${TO} | - | ${guests} | asked\n`;
const chatCard = (attendees) => ({
  action: "create", account: "personal", summary: "Budget review",
  from: FROM, to: TO, attendees, why: "asked",
});

test("a guest list change is not treated as the same booking", async () => {
  const { pendingPath, statePath } = await bench("orderly-identity-");
  await writeFile(pendingPath, logged("-"));
  await observeProposal({ statePath, card: chatCard("cfo@example.com"), desk: "coordinator" });
  const queue = await readQueue({ pendingPath, statePath });
  assert.equal(
    queue.pending.length,
    2,
    `two bookings were filed whose approvals would invite different people, and the queue ` +
      `shows ${queue.pending.length} card(s). The surviving one invites ` +
      `${JSON.stringify(queue.pending[0]?.attendees)}.`,
  );
});

test("genuine duplicates still collapse, for bookings and for drafts", async () => {
  const events = await bench("orderly-identity-same-");
  await writeFile(events.pendingPath, logged("cfo@example.com"));
  await observeProposal({ statePath: events.statePath, card: chatCard("cfo@example.com"), desk: "coordinator" });
  const eventQueue = await readQueue(events);
  assert.equal(eventQueue.pending.length, 1, "one real booking must be one card");

  const drafts = await bench("orderly-identity-draft-");
  const now = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}`;
  await writeFile(drafts.pendingPath, `- q-${stamp}-1 | chat | personal | boss@example.com | Re: numbers\n`);
  await observeDraft({
    statePath: drafts.statePath,
    card: { subject: "Re: numbers", to: "boss@example.com", account: "personal" },
    desk: "coordinator",
  });
  const draftQueue = await readQueue(drafts);
  assert.equal(draftQueue.pending.length, 1, "one draft announced twice must stay one card");
});

test("one booking logged and also seen in chat stays a single card", async () => {
  // PENDING.md has no column for location or description, so a logged line
  // always reports them absent. That must not split one real booking in two.
  const { pendingPath, statePath } = await bench("orderly-identity-cross-");
  await writeFile(pendingPath, logged("-"));
  await observeProposal({
    statePath,
    card: { ...chatCard(undefined), location: "Conference Room", description: "quarterly numbers" },
    desk: "coordinator",
  });
  const queue = await readQueue({ pendingPath, statePath });
  assert.equal(
    queue.pending.length,
    1,
    `the same booking arrived through both paths and produced ${queue.pending.length} cards; ` +
      `the logged line cannot carry location or description, which is not the same as differing.`,
  );
});

test("an event id a create would never send does not split one booking in two", async () => {
  const { pendingPath, statePath } = await bench("orderly-identity-create-id-");
  await writeFile(pendingPath, "");
  // applyProposal() sends a create as { account, payload }. It never reads
  // eventId on that path, so two creates that differ only there produce exactly
  // the same booking and are one request to approve.
  await observeProposal({ statePath, card: chatCard("-"), desk: "coordinator" });
  await observeProposal({
    statePath,
    card: { ...chatCard("-"), eventId: "abc123def456" },
    desk: "coordinator",
  });
  const queue = await readQueue({ pendingPath, statePath });
  assert.equal(
    queue.pending.length,
    1,
    `two create proposals differ only by an event id that the create path never `
      + `sends, so approving either books the same thing, and the queue shows `
      + `${queue.pending.length} card(s).`,
  );
});

test("an update target still decides identity", async () => {
  const { pendingPath, statePath } = await bench("orderly-identity-update-id-");
  await writeFile(pendingPath, "");
  // The update path does send it, so two updates aimed at different events are
  // two different changes.
  const update = (eventId) => ({ ...chatCard("-"), action: "update", eventId });
  await observeProposal({ statePath, card: update("abc123def456"), desk: "coordinator" });
  await observeProposal({ statePath, card: update("999888777666"), desk: "coordinator" });
  const queue = await readQueue({ pendingPath, statePath });
  assert.equal(
    queue.pending.length,
    2,
    `two proposals rewrite different existing events, and the queue shows `
      + `${queue.pending.length} card(s).`,
  );
});
