import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, expect, webkit } from "@playwright/test";

const origin = process.env.DEPOT_LIVE_URL;
const allowlist = ["http://127.0.0.1:4186", "https://depot-live.artemislab.co.uk"];
assert.ok(allowlist.includes(origin), "Set DEPOT_LIVE_URL to the exact loopback or branded live service origin.");

for (const [engine, width] of [[chromium, 1280], [webkit, 320]]) {
  const browser = await engine.launch();
  try {
    const context = await browser.newContext({ viewport: { width, height: 880 }, isMobile: width === 320 });
    const health = await context.request.get(origin + "/api/health", { maxRedirects: 0 });
    assert.equal(health.status(), 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const references = ["CHECK-" + randomUUID().slice(0, 8), "CHECK-" + randomUUID().slice(0, 8)];
    const first = await context.newPage();
    const second = await context.newPage();
    const slot = { bay: 1, hour: 8 };
    let boardUrl;
    try {
      await first.goto(origin);
      assert.equal(new URL(first.url()).origin, origin);
      await expect(first.getByText("Reserve an hour for a delivery or collection.")).toBeVisible();
      const start = await first.getByLabel("Booking date").getAttribute("min");
      const tomorrow = new Date(start + "T12:00:00Z");
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const date = tomorrow.toISOString().slice(0, 10);
      boardUrl = origin + "/api/board?date=" + date;

      await second.goto(origin);
      assert.equal(new URL(second.url()).origin, origin);
      for (const [index, tab] of [first, second].entries()) {
        await tab.getByLabel("Booking date").fill(date);
        await tab.getByRole("button", { name: "08:00 Available, Bay 1", exact: true }).click();
        await tab.getByLabel("Load reference").fill(references[index]);
        assert.equal(await tab.evaluate(() => document.documentElement.scrollWidth), width);
      }

      const tabs = [first, second];
      const [outcomes] = await Promise.all([
        Promise.all(tabs.map(tab => tab.waitForResponse(response =>
          response.url() === origin + "/api/bookings" && response.request().method() === "POST"))),
        Promise.all(tabs.map(tab => tab.getByRole("button", { name: "Reserve slot", exact: true }).click())),
      ]);
      assert.deepEqual(outcomes.map(response => response.status()).sort(), [201, 409]);
      const winner = await outcomes.find(response => response.status() === 201).json();
      const loser = tabs[outcomes.findIndex(response => response.status() === 409)];
      await expect(loser.getByRole("status")).toContainText("This slot was just booked. Choose another time.");
      await loser.reload();
      await loser.getByLabel("Booking date").fill(date);
      await expect(loser.getByText(winner.reference, { exact: true })).toBeVisible();
      const saved = await context.request.get(boardUrl, { maxRedirects: 0 });
      assert.equal(saved.status(), 200);
      assert.deepEqual((await saved.json()).bookings, [winner]);
      assert.ok(references.includes(winner.reference) && winner.bay === slot.bay && winner.hour === slot.hour);
    } finally {
      if (boardUrl) {
        const remaining = await context.request.get(boardUrl, { maxRedirects: 0 });
        assert.equal(remaining.status(), 200);
        for (const booking of (await remaining.json()).bookings.filter(row => references.includes(row.reference))) {
          const removed = await context.request.delete(origin + "/api/bookings/" + booking.id, {
            headers: { Origin: origin }, maxRedirects: 0,
          });
          assert.equal(removed.status(), 204, "Remove the verification booking from its disposable workspace.");
        }
      }
    }
    console.log(`${width}px: 201 and 409, conflict visible, one booking after reload, test booking removed.`);
  } finally {
    await browser.close();
  }
}
