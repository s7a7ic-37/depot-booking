import { test, expect } from "@playwright/test";

test("a replacement booking survives cancellation from a stale phone tab", async ({ page, context }) => {
  const apiRequests = [];
  context.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.method());
  });
  await page.goto("/");
  await expect(page.getByText("Browser demo · Sample bookings stay in this browser.")).toBeVisible();
  const date = page.getByLabel("Booking date");
  const tomorrow = new Date((await date.getAttribute("min")) + "T12:00:00Z");
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const day = tomorrow.toISOString().slice(0, 10);
  await date.fill(day);
  await expect(date).toHaveValue(day);

  const slot = "Bay 1, 08:00";
  async function book(tab, reference) {
    await tab.getByRole("button", { name: slot + ", Available", exact: true }).click();
    await tab.getByLabel("Load reference").fill(reference);
    await tab.getByRole("button", { name: "Reserve slot", exact: true }).click();
    await expect(tab.getByRole("status")).toContainText(reference);
  }
  async function cancel(tab) {
    tab.once("dialog", dialog => dialog.accept());
    await tab.getByRole("button", { name: "Cancel bay 1 at 08:00", exact: true }).click();
  }

  await book(page, "FIRST-LOAD");
  const stale = await context.newPage();
  await stale.goto("/");
  await stale.getByLabel("Booking date").fill(day);
  await expect(stale.getByText("FIRST-LOAD", { exact: true })).toBeVisible();
  await cancel(page);
  await expect(page.getByRole("status")).toContainText("Booking cancelled.");
  await book(page, "REPLACEMENT-LOAD");
  await cancel(stale);
  await expect(stale.getByRole("status")).toContainText("That booking could not be cancelled.");
  await expect(stale.getByText("REPLACEMENT-LOAD", { exact: true })).toBeVisible();
  await expect(stale.getByRole("button", { name: slot + ", Booked", exact: true })).toBeDisabled();
  expect(await stale.evaluate(() => document.documentElement.scrollWidth === innerWidth)).toBe(true);
  expect(apiRequests).toEqual([]);
});
