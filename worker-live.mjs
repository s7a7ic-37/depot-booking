const workspaceCookie = /^depot_workspace=[0-9a-f]{32}$/i;
const bookingPath = /^\/api\/bookings\/[1-9]\d{0,18}$/;
const movePath = /^\/api\/bookings\/[1-9]\d{0,18}\/move$/;

function error(status, message) {
  return Response.json({ message }, { status, headers: { "Cache-Control": "no-store" } });
}

const unavailable = () => error(503, "Booking service temporarily unavailable. Try again shortly.");

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname: path, origin } = url;
    if (path !== "/api" && !path.startsWith("/api/")) return env.ASSETS.fetch(request);

    const { method } = request;
    const board = method === "GET" && path === "/api/board";
    const health = method === "GET" && path === "/api/health";
    const reserve = method === "POST" && path === "/api/bookings";
    const move = method === "POST" && movePath.test(path);
    const cancel = method === "DELETE" && bookingPath.test(path);
    if (!(board || health || reserve || move || cancel)) return error(404, "Booking API route not found.");
    if (url.searchParams.size && (!board || url.searchParams.size !== 1 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("date") || ""))) {
      return error(400, "Choose a valid booking date.");
    }

    if (method !== "GET" && request.headers.get("Origin") !== origin) return error(403, "Request origin is not allowed.");
    if (method === "POST" && request.headers.get("Content-Type")?.split(";", 1)[0] !== "application/json") {
      return error(415, "Send the booking as JSON.");
    }

    try {
      const target = new URL(env.API_ORIGIN);
      if (target.protocol !== "https:" || !/^[a-z0-9-]+\.onrender\.com$/.test(target.hostname) ||
          target.port || target.username || target.password || target.pathname !== "/" || target.search || target.hash) {
        return unavailable();
      }
      target.pathname = path;
      target.search = url.search;
      const headers = new Headers({ Accept: "application/json" });
      if (method !== "GET") headers.set("Origin", origin);
      if (method === "POST") headers.set("Content-Type", "application/json");
      const cookies = (request.headers.get("Cookie") || "").split(";").map(value => value.trim()).filter(value => workspaceCookie.test(value));
      if (!health && cookies.length === 1) headers.set("Cookie", cookies[0]);
      const response = await fetch(target, {
        method, headers, redirect: "manual", cache: "no-store",
        body: method === "POST" ? request.body : undefined,
      });
      const { status } = response;
      if ((status >= 300 && status < 400) || status >= 500) return unavailable();
      const outgoing = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      if (status === 204) return new Response(null, { status, headers: outgoing });

      const type = response.headers.get("Content-Type")?.split(";", 1)[0];
      if (type !== "application/json" && type !== "application/problem+json") {
        if (status === 429) return error(429, "Booking service is busy. Try again shortly.");
        if (status >= 400) return error(status, "The booking request could not be completed.");
        return unavailable();
      }
      outgoing.set("Content-Type", type);
      if ((board && status === 200) || (reserve && status === 201)) {
        const issued = response.headers.getAll?.("Set-Cookie") ?? response.headers.getSetCookie();
        const workspace = issued.map(value => value.split(";").map(part => part.trim()))
          .filter(([cookie]) => workspaceCookie.test(cookie));
        if (workspace.length === 1) {
          const [cookie, ...options] = workspace[0];
          const age = options.find(value => /^max-age=\d{1,8}$/i.test(value));
          if (age) outgoing.set("Set-Cookie", cookie + "; " + age + "; Path=/api; HttpOnly; Secure; SameSite=Strict");
        }
      }
      return new Response(response.body, { status, headers: outgoing });
    } catch {
      return unavailable();
    }
  },
};
