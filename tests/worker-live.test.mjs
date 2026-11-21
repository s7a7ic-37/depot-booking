import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker-live.mjs";

const site = "https://depot-live.artemislab.co.uk";
const render = "https://synthetic-depot-test.onrender.com";
const env = { API_ORIGIN: render };
const workspace = "depot_workspace=" + "1".repeat(32);
const request = (path, options) => new Request(site + path, options);
const noNetwork = () => { throw new Error("Unexpected upstream request."); };

test("assets remain local and an absent or invalid Render origin never fetches", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", noNetwork);
  const assets = { fetch: () => new Response("Depot UI") };
  assert.equal(await (await worker.fetch(request("/"), { ASSETS: assets })).text(), "Depot UI");
  for (const origin of [undefined, "http://synthetic-depot-test.onrender.com", render + "/other",
    render + "@different.example", "https://synthetic-depot-test.onrender.com.example"]) {
    assert.equal((await worker.fetch(request("/api/health"), { API_ORIGIN: origin })).status, 503);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("board uses only the configured host, date and workspace cookie", async (t) => {
  t.mock.method(globalThis, "fetch", async (target, init) => {
    assert.equal(target.href, render + "/api/board?date=2026-12-01");
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    assert.equal(init.cache, "no-store");
    assert.deepEqual(Object.fromEntries(init.headers), { accept: "application/json", cookie: workspace });
    const headers = new Headers({ "Cache-Control": "public" });
    headers.append("Set-Cookie", "unrelated=discard; Path=/");
    headers.append("Set-Cookie", workspace + "; Max-Age=1296000; Domain=artemislab.co.uk; Path=/");
    return Response.json({ bookings: [] }, { headers });
  });
  const response = await worker.fetch(request("/api/board?date=2026-12-01", { headers: {
    Cookie: workspace + "; unrelated=discard",
    Authorization: "fixture-header",
    Origin: "https://other.example",
  } }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { bookings: [] });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Set-Cookie"), workspace + "; Max-Age=1296000; Path=/api; HttpOnly; Secure; SameSite=Strict");
});

test("unknown methods, paths, query parameters and cross-origin writes do not reach Render", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", noNetwork);
  for (const [path, options, status] of [
    ["/api/internal", {}, 404],
    ["/api/board", { method: "PUT" }, 404],
    ["/api/board?date=2026-12-01&next=https://other.example", {}, 400],
    ["/api/board?date=2026-12-01&date=2026-12-02", {}, 400],
    ["/api/health?date=2026-12-01", {}, 400],
    ["/api/bookings/1", { method: "DELETE", headers: { Origin: "https://other.example" } }, 403],
    ["/api/bookings/1/move", { method: "POST", headers: { Origin: site, "Content-Type": "text/plain" } }, 415],
  ]) {
    const response = await worker.fetch(request(path, options), env);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("same-origin booking actions keep their JSON status and work without redirect following", async (t) => {
  const targetBooking = { date: "2026-12-01", bay: 1, hour: 9 };
  const fetch = t.mock.method(globalThis, "fetch", async (target, init) => {
    assert.equal(target.origin, render);
    assert.equal(init.headers.get("Origin"), site);
    assert.equal(init.headers.get("Cookie"), workspace);
    if (init.method === "DELETE") {
      assert.equal(target.pathname, "/api/bookings/2");
      return new Response(null, { status: 204 });
    }
    assert.equal(target.pathname, "/api/bookings/2/move");
    assert.equal(init.method, "POST");
    assert.deepEqual(await new Response(init.body).json(), targetBooking);
    assert.equal(init.redirect, "manual");
    return Response.json({ message: "Slot taken." }, { status: 409 });
  });
  const headers = { Origin: site, "Content-Type": "application/json", Cookie: workspace };
  const clash = await worker.fetch(request("/api/bookings/2/move", {
    method: "POST", headers, body: JSON.stringify(targetBooking),
  }), env);
  assert.equal(clash.status, 409);
  assert.deepEqual(await clash.json(), { message: "Slot taken." });
  assert.equal((await worker.fetch(request("/api/bookings/2", { method: "DELETE", headers }), env)).status, 204);
  assert.equal(fetch.mock.callCount(), 2);
});

test("upstream redirects, throttling and failures return safe no-store errors", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", noNetwork);
  for (const [upstream, status] of [[302, 503], [429, 429], [502, 503], [0, 503]]) {
    fetch.mock.mockImplementationOnce(async (_target, init) => {
      assert.equal(init.redirect, "manual");
      assert.equal(init.headers.has("Cookie"), false);
      if (upstream === 0) throw new Error("Upstream details");
      return new Response("Upstream details", { status: upstream, headers: { Location: "https://other.example" } });
    });
    const response = await worker.fetch(request("/api/health", { headers: { Cookie: workspace } }), env);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.has("Location"), false);
    assert.doesNotMatch(await response.text(), /Upstream details/);
  }
  assert.equal(fetch.mock.callCount(), 4);
});
