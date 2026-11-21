# Depot Booking

Book a one hour slot at one of three loading bays. The React schedule is served by an ASP.NET Core API. PostgreSQL enforces one booking per date, bay and hour. If two people request the same slot, one succeeds and the other sees the updated schedule.

## Run locally

Use .NET 10, Node 22.12+ and a separate local PostgreSQL database. Set the connection string in the environment as ConnectionStrings__Depot. The API creates its bookings table when it starts.

    cd web
    npm ci
    npm run build
    cd ../api
    dotnet run --urls http://127.0.0.1:4186

Open http://127.0.0.1:4186. Times are in UK local time and bookings are open for the next 14 days. Use fictional load references.

## Check concurrent reservations

Run against a separate loopback test database. The checks create a synthetic booking and confirm that invalid requests do not change the schedule.

    node --test tests/booking.test.mjs

The starter is a local demo with a shared booking board.
