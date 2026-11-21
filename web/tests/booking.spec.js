import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function dateAfter(dateField, days) {
  const date = new Date((await dateField.getAttribute("min")) + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function book(tab, slot, reference) {
  await tab.getByRole("button", { name: slot + ", Available", exact: true }).click();
  await tab.getByLabel("Load reference").fill(reference);
  await tab.getByRole("button", { name: "Reserve slot", exact: true }).click();
  await expect(tab.getByRole("status")).toContainText(reference);
}

test("a replacement booking survives cancellation from a stale phone tab", async ({ page, context }) => {
  const apiRequests = [];
  context.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.method());
  });
  await page.goto("/");
  await expect(page.getByText("Browser demo · Sample bookings stay in this browser.")).toBeVisible();
  const date = page.getByLabel("Booking date");
  const day = await dateAfter(date, 1);
  await date.fill(day);
  await expect(date).toHaveValue(day);

  const slot = "Bay 1, 08:00";
  async function cancel(tab) {
    tab.once("dialog", dialog => dialog.accept());
    await tab.getByRole("button", { name: "Cancel bay 1 at 08:00", exact: true }).click();
  }

  await book(page, slot, "FIRST-LOAD");
  const stale = await context.newPage();
  await stale.goto("/");
  await stale.getByLabel("Booking date").fill(day);
  await expect(stale.getByText("FIRST-LOAD", { exact: true })).toBeVisible();
  await cancel(page);
  await expect(page.getByRole("status")).toContainText("Booking cancelled.");
  await book(page, slot, "REPLACEMENT-LOAD");
  await cancel(stale);
  await expect(stale.getByRole("status")).toContainText("That booking could not be cancelled.");
  await expect(stale.getByText("REPLACEMENT-LOAD", { exact: true })).toBeVisible();
  await expect(stale.getByRole("button", { name: slot + ", Booked", exact: true })).toBeDisabled();
  expect(await stale.evaluate(() => document.documentElement.scrollWidth === innerWidth)).toBe(true);
  expect(apiRequests).toEqual([]);
});

test("keyboard cancellation keeps focus in the schedule at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/");
  const date = page.getByLabel("Booking date");
  await date.fill(await dateAfter(date, 1));
  await book(page, "Bay 1, 08:00", "FIRST");
  await book(page, "Bay 1, 09:00", "SECOND");

  for (const [hour, heading] of [["08:00", "Bookings for this day"], ["09:00", "Time slots"]]) {
    const button = page.getByRole("button", { name: "Cancel bay 1 at " + hour, exact: true });
    await button.focus();
    page.once("dialog", dialog => dialog.accept());
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toContainText("Booking cancelled.");
    await expect(button).toHaveCount(0);
    await expect(page.getByRole("heading", { name: heading })).toBeFocused();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
});

test("day CSV includes every bay in order and protects spreadsheet references", async ({ page, browser, baseURL }) => {
  await page.goto("/");
  const date = page.getByLabel("Booking date");
  const csv = page.getByRole("button", { name: "Download day CSV", exact: true });
  const day = await dateAfter(date, 1);
  const otherDay = await dateAfter(date, 2);
  await expect(csv).toBeDisabled();
  await date.fill(otherDay);
  await book(page, "Bay 1, 08:00", "OTHER-DAY");
  await date.fill(day);
  await expect(date).toHaveValue(day);
  await expect(csv).toBeDisabled();
  await page.getByRole("button", { name: "Bay 2", exact: true }).click();
  await book(page, "Bay 2, 14:00", "BAY-TWO");
  await page.getByRole("button", { name: "Bay 1", exact: true }).click();
  await book(page, "Bay 1, 11:00", "LATER");
  await book(page, "Bay 1, 08:00", "-LOAD-101");

  const nextDownload = page.waitForEvent("download");
  await csv.click();
  const download = await nextDownload;
  expect(download.suggestedFilename()).toBe("depot-bookings-" + day + ".csv");
  expect(await readFile(await download.path(), "utf8")).toBe([
    "Date,Bay,Start time (UK),Load reference",
    day + ',1,08:00,"\t-LOAD-101"',
    day + ',1,11:00,"LATER"',
    day + ',2,14:00,"BAY-TWO"',
    "",
  ].join("\r\n"));
  await expect(csv).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth)).toBe(true);

  const isolated = await browser.newContext({ baseURL });
  try {
    const visitor = await isolated.newPage();
    await visitor.goto("/");
    const visitorDate = visitor.getByLabel("Booking date");
    await visitorDate.fill(day);
    await expect(visitorDate).toHaveValue(day);
    await expect(visitor.getByRole("button", { name: "Download day CSV", exact: true })).toBeDisabled();
    await expect(visitor.getByRole("button", { name: "Bay 1, 08:00, Available", exact: true })).toBeEnabled();
  } finally {
    await isolated.close();
  }
});

test("two tabs moving to one slot preserve the booking that loses the conflict", async ({ page, context }) => {
  await page.goto("/");
  const date = page.getByLabel("Booking date");
  const day = await dateAfter(date, 1);
  await date.fill(day);
  await book(page, "Bay 1, 08:00", "FIRST");
  await book(page, "Bay 1, 10:00", "SECOND");

  const other = await context.newPage();
  await other.goto("/");
  await other.getByLabel("Booking date").fill(day);
  await expect(other.getByText("SECOND", { exact: true })).toBeVisible();

  const moveFirst = page.getByRole("button", { name: "Move bay 1 at 08:00" });
  await moveFirst.click();
  await expect(page.getByRole("heading", { name: "Time slots" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Confirm move" })).toBeDisabled();
  await page.getByRole("button", { name: "Keep current booking" }).click();
  await expect(page.getByRole("status")).toContainText("Your booking is unchanged.");
  await expect(moveFirst).toBeEnabled();

  await moveFirst.click();
  await other.getByRole("button", { name: "Move bay 1 at 10:00" }).click();
  for (const tab of [page, other]) {
    await tab.getByRole("button", { name: "Bay 2", exact: true }).click();
    await tab.getByRole("button", { name: "Bay 2, 09:00, Available" }).click();
  }
  await Promise.all([page, other].map(tab => tab.getByRole("button", { name: "Confirm move" }).click()));
  await expect.poll(async () => {
    const statuses = await Promise.all([page, other].map(tab => tab.getByRole("status").textContent()));
    return statuses.filter(message => /^(Moved |That slot is taken)/.test(message)).length;
  }).toBe(2);
  const pageWon = (await page.getByRole("status").textContent()).startsWith("Moved FIRST");
  const winner = pageWon ? page : other;
  const loser = pageWon ? other : page;
  await expect(winner.getByRole("status")).toContainText("to bay 2 at 09:00.");
  await expect(loser.getByRole("status")).toContainText("Your original booking is still in place.");

  await page.getByRole("button", { name: "Refresh schedule" }).click();
  const bookings = page.getByRole("region", { name: "Bookings for this day" }).getByRole("listitem");
  await expect(bookings).toHaveCount(2);
  await expect(bookings.filter({ hasText: pageWon ? "FIRST" : "SECOND" })).toContainText("Bay 2 · 09:00");
  await expect(bookings.filter({ hasText: pageWon ? "SECOND" : "FIRST" })).toContainText(pageWon ? "Bay 1 · 10:00" : "Bay 1 · 08:00");
  expect(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth)).toBe(true);
});
