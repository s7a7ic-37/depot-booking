import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const origin = new URL(process.env.DEPOT_TEST_URL || "http://127.0.0.1:4186");
if (origin.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)) {
  throw new Error("Run booking checks against a dedicated loopback test service.");
}

function workspace() {
  let cookie = "";
  return {
    async read(date) {
      const url = new URL("/api/board", origin);
      if (date) url.searchParams.set("date", date);
      const response = await fetch(url, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      const issued = response.headers.get("Set-Cookie");
      if (issued) {
        assert.match(issued, /httponly/i);
        cookie = issued.split(";", 1)[0];
      }
      return response.json();
    },
    reserve(booking) {
      return fetch(new URL("/api/bookings", origin), {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin.origin, Cookie: cookie },
        body: JSON.stringify(booking),
      });
    },
    cancel(id) {
      return fetch(new URL("/api/bookings/" + id, origin), {
        method: "DELETE",
        headers: { Origin: origin.origin, Cookie: cookie },
      });
    },
  };
}

test("simultaneous requests for one slot save exactly one booking", async () => {
  const client = workspace();
  const initial = await client.read();
  const tomorrow = new Date(initial.firstDay + "T12:00:00Z");
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const board = await client.read(tomorrow.toISOString().slice(0, 10));
  const hour = Array.from({ length: board.lastHour - board.firstHour + 1 }, (_, i) => board.firstHour + i)
    .find((slot) => !board.bookings.some((booking) => booking.bay === 1 && booking.hour === slot));
  assert.ok(hour, "Use a fresh test database with an available slot");
  const reference = "TEST-" + randomUUID().slice(0, 6);
  const input = { date: board.date, bay: 1, hour, reference };
  const outcomes = await Promise.all([client.reserve(input), client.reserve({ ...input, reference: reference + "-B" })]);
  assert.deepEqual(outcomes.map((response) => response.status).sort(), [201, 409]);
  const saved = await outcomes.find((response) => response.status === 201).json();
  const after = await client.read(board.date);
  assert.deepEqual(after.bookings.filter((booking) => booking.bay === 1 && booking.hour === hour), [saved]);
  const visitor = workspace();
  assert.deepEqual((await visitor.read(board.date)).bookings, []);
  assert.equal((await visitor.reserve({ ...input, reference: "OTHER-DEMO" })).status, 201);
  assert.deepEqual((await client.read(board.date)).bookings, after.bookings);
  assert.equal((await visitor.cancel(saved.id)).status, 404);
  assert.equal((await client.cancel(saved.id)).status, 204);
  assert.deepEqual((await client.read(board.date)).bookings, []);
  const replacementResponse = await client.reserve({ ...input, reference: "REPLACEMENT" });
  assert.equal(replacementResponse.status, 201);
  const replacement = await replacementResponse.json();
  assert.notEqual(replacement.id, saved.id);
  assert.equal((await client.cancel(saved.id)).status, 404);
  assert.deepEqual((await client.read(board.date)).bookings, [replacement]);
});

test("invalid date, bay, hour and reference leave the board unchanged", async () => {
  const client = workspace();
  const board = await client.read();
  const booking = { date: board.date, bay: 1, hour: board.firstHour, reference: "DEMO-1" };
  assert.equal((await workspace().reserve(booking)).status, 401);
  for (const overrides of [{ date: "2020-01-01" }, { bay: 4 }, { hour: 22 }, { reference: "  " }, { reference: "No@" }]) {
    assert.equal((await client.reserve({ ...booking, ...overrides })).status, 400);
  }
  assert.deepEqual((await client.read(board.date)).bookings, board.bookings);
});
