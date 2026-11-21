# Depot Booking

Book an hour at one of three loading bays. The full stack version uses React, ASP.NET Core and PostgreSQL. PostgreSQL enforces one booking per date, bay and hour within each browser workspace. Two tabs in the same workspace can try the same slot and see one booking succeed.

[Try the browser demo](https://depot.artemislab.co.uk/). Demo bookings stay in IndexedDB. The unique slot key demonstrates the same conflict in two tabs without a server account.

Future bookings can be cancelled and booked again. Cancellation checks the booking ID so an older tab cannot cancel a replacement.
Move a booking to a different slot on the same day. If the new slot is taken, the original reservation stays in place. A successful move gives the replacement its own ID.

Download the displayed day's bookings across all bays as CSV. Rows are sorted by bay and UK start time. The export includes the date, bay, start time and load reference.

## Run locally

Use .NET 10, Node 22.12+ and a separate local PostgreSQL database. Set the connection string in the environment as ConnectionStrings__Depot. The API creates its bookings table when it starts. A seven-day HttpOnly cookie separates workspaces.

    cd web
    npm ci
    npm run build
    cd ../api
    dotnet run --urls http://127.0.0.1:4186

Open http://127.0.0.1:4186. Times are in UK local time and bookings are open for the next 14 days. Use fictional load references.

For Docker Compose, put a private URL-safe DEPOT_DB_PASSWORD in a local .env file, run docker compose up --build and open http://localhost:4186.

Build the static browser demo with npm run build:demo from web.

The browser checks run the demo on loopback. Install Chromium and WebKit with npx playwright install --only-shell chromium webkit from web, then run npm run test:browser.

## Check concurrent reservations

Run against a separate loopback test database. The checks create a synthetic booking and confirm that invalid requests do not change the schedule.

    node --test tests/booking.test.mjs

For an HTTPS server deployment set SecureCookies=true and SiteOrigin to the public origin. Demo workspace cookies identify a browser workspace. Use fictional references.
