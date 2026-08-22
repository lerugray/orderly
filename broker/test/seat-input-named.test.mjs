// An unreadable seat input is named, and named from the failure itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeatInvoker } from "../seat.mjs";

const ASK = { ask: "do a thing", allowlist: { presets: [], repos: [] }, laneRegistry: { lanes: () => [] } };

async function paths(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const ordersPath = join(dir, "orders.md");
  const schemaPath = join(dir, "schema.md");
  await writeFile(ordersPath, "# orders\n");
  await writeFile(schemaPath, "# schema\n");
  return { dir, ordersPath, schemaPath };
}

const runnable = (over) => new SeatInvoker({
  command: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 5_000, ...over,
});

test("each unreadable input is named, and named correctly", async () => {
  // A seat that really can run, with one input removed at a time, so a failure
  // cannot be blamed on the command.
  const a = await paths("named-orders-");
  const b = await paths("named-schema-");

  // Ask for a consultation with the standing orders absent.
  const missingOrders = await runnable({
    ordersPath: join(a.dir, "gone.md"), schemaPath: a.schemaPath,
  }).consult(ASK);

  // And again with the packet schema absent.
  const missingSchema = await runnable({
    ordersPath: b.ordersPath, schemaPath: join(b.dir, "gone.md"),
  }).consult(ASK);

  const orders = `${missingOrders.seat_failure?.code} / ${missingOrders.seat_failure?.message}`;
  const schema = `${missingSchema.seat_failure?.code} / ${missingSchema.seat_failure?.message}`;
  assert.ok(
    /seat_input_unreadable/.test(orders) && /standing orders/.test(orders)
      && /seat_input_unreadable/.test(schema) && /packet schema/.test(schema),
    `the seat command is runnable and exactly one input is absent, so each case `
      + `must name that input. Missing orders gave "${orders}". `
      + `Missing schema gave "${schema}".`,
  );
});
