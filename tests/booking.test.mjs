import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const origin = new URL(process.env.DEPOT_TEST_URL || "http://127.0.0.1:4186");
if (origin.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)) {
  throw new Error("Run booking checks against a dedicated loopback test service.");
}

const readBoard = async (date) => {
  const url = new URL("/api/board", origin);
  if (date) url.searchParams.set("date", date);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json();
};
const reserve = (booking) => fetch(new URL("/api/bookings", origin), {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(booking),
});

test("simultaneous requests for one slot save exactly one booking", async () => {
  const initial = await readBoard();
  const tomorrow = new Date(initial.firstDay + "T12:00:00Z");
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const board = await readBoard(tomorrow.toISOString().slice(0, 10));
  const hour = Array.from({ length: board.lastHour - board.firstHour + 1 }, (_, i) => board.firstHour + i)
    .find((slot) => !board.bookings.some((booking) => booking.bay === 1 && booking.hour === slot));
  assert.ok(hour, "Use a fresh test database with an available slot");
  const reference = "TEST-" + randomUUID().slice(0, 6);
  const input = { date: board.date, bay: 1, hour, reference };
  const outcomes = await Promise.all([reserve(input), reserve({ ...input, reference: reference + "-B" })]);
  assert.deepEqual(outcomes.map((response) => response.status).sort(), [201, 409]);
  const saved = await outcomes.find((response) => response.status === 201).json();
  const after = await readBoard(board.date);
  assert.deepEqual(after.bookings.filter((booking) => booking.bay === 1 && booking.hour === hour), [saved]);
});

test("invalid date, bay, hour and reference leave the board unchanged", async () => {
  const board = await readBoard();
  const booking = { date: board.date, bay: 1, hour: board.firstHour, reference: "DEMO-1" };
  for (const overrides of [{ date: "2020-01-01" }, { bay: 4 }, { hour: 22 }, { reference: "  " }, { reference: "No@" }]) {
    assert.equal((await reserve({ ...booking, ...overrides })).status, 400);
  }
  assert.deepEqual((await readBoard(board.date)).bookings, board.bookings);
});
