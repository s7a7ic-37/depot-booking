using Npgsql;

const int bayCount = 3;
const int firstHour = 8;
const int lastHour = 16;
const int bookingHorizon = 14;
const string workspaceCookie = "depot_workspace";
var london = TimeZoneInfo.FindSystemTimeZoneById("Europe/London");
DateTime NowInLondon() => TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, london).DateTime;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddProblemDetails();
var connectionString = builder.Configuration.GetConnectionString("Depot")
    ?? throw new InvalidOperationException("Set ConnectionStrings__Depot for your local PostgreSQL database.");
var secureCookies = builder.Configuration.GetValue<bool>("SecureCookies");
var siteOrigin = builder.Configuration["SiteOrigin"];
await using var database = NpgsqlDataSource.Create(connectionString);
await using (var setup = database.CreateCommand("""
    CREATE TABLE IF NOT EXISTS depot_reservations (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        workspace uuid NOT NULL,
        booked_on date NOT NULL,
        bay smallint NOT NULL CHECK (bay BETWEEN 1 AND 3),
        start_hour smallint NOT NULL CHECK (start_hour BETWEEN 8 AND 16),
        reference text NOT NULL CHECK (length(reference) BETWEEN 1 AND 32),
        UNIQUE (workspace, booked_on, bay, start_hour)
    )
    """))
{
    await setup.ExecuteNonQueryAsync();
}

var app = builder.Build();
app.UseExceptionHandler();
app.UseDefaultFiles();
app.UseStaticFiles();

app.Use(async (context, next) =>
{
    if (context.Request.Path.StartsWithSegments("/api"))
    {
        context.Response.Headers.CacheControl = "no-store";
        if (siteOrigin is not null && !HttpMethods.IsGet(context.Request.Method) &&
            context.Request.Headers.Origin.ToString() != siteOrigin)
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }
    }
    await next();
});

bool ReadWorkspace(HttpContext context, out Guid workspace) =>
    Guid.TryParseExact(context.Request.Cookies[workspaceCookie], "N", out workspace) && workspace != Guid.Empty;

string? SlotError(DateOnly date, int bay, int hour, DateTime now)
{
    var today = DateOnly.FromDateTime(now);
    if (date < today || date > today.AddDays(bookingHorizon))
        return "Choose a date within the next 14 days.";
    if (bay is < 1 or > bayCount || hour is < firstHour or > lastHour)
        return "Choose an available bay and hour.";
    if (date == today && hour <= now.Hour)
        return "That hour has already started. Choose a later time.";
    return null;
}

app.MapGet("/api/board", async Task<IResult> (DateOnly? date, HttpContext context, CancellationToken cancellation) =>
{
    var now = NowInLondon();
    var firstDay = DateOnly.FromDateTime(now);
    var lastDay = firstDay.AddDays(bookingHorizon);
    var day = date ?? (now.Hour >= lastHour ? firstDay.AddDays(1) : firstDay);
    if (day < firstDay || day > lastDay)
        return Results.BadRequest(new { message = "Choose a date within the next 14 days." });

    if (!ReadWorkspace(context, out var workspace))
    {
        workspace = Guid.NewGuid();
        context.Response.Cookies.Append(workspaceCookie, workspace.ToString("N"), new CookieOptions
        {
            HttpOnly = true,
            Secure = secureCookies,
            SameSite = SameSiteMode.Strict,
            Path = "/api",
            MaxAge = TimeSpan.FromDays(7)
        });
    }
    await using var query = database.CreateCommand("""
        SELECT id, bay, start_hour, reference
        FROM depot_reservations WHERE workspace = $1 AND booked_on = $2 ORDER BY bay, start_hour
        """);
    query.Parameters.Add(new NpgsqlParameter { Value = workspace });
    query.Parameters.Add(new NpgsqlParameter { Value = day });
    await using var rows = await query.ExecuteReaderAsync(cancellation);
    var bookings = new List<Booking>();
    while (await rows.ReadAsync(cancellation))
        bookings.Add(new Booking(rows.GetInt64(0), rows.GetInt16(1), rows.GetInt16(2), rows.GetString(3)));

    var availableFrom = day == firstDay ? Math.Max(firstHour, now.Hour + 1) : firstHour;
    return Results.Ok(new { date = day, firstDay, lastDay, bayCount, firstHour, lastHour, availableFrom, bookings });
});

app.MapPost("/api/bookings", async Task<IResult> (BookingRequest request, HttpContext context, CancellationToken cancellation) =>
{
    if (!ReadWorkspace(context, out var workspace))
        return Results.Json(new { message = "Refresh the schedule to start a workspace." }, statusCode: 401);

    if (SlotError(request.Date, request.Bay, request.Hour, NowInLondon()) is { } error)
        return Results.BadRequest(new { message = error });

    var reference = request.Reference?.Trim();
    if (reference is null || reference.Length is < 1 or > 32 ||
        reference.Any(c => !char.IsAsciiLetterOrDigit(c) && c != '-' && c != ' '))
        return Results.BadRequest(new { message = "Use 1 to 32 letters, numbers, spaces or hyphens for the load reference." });

    await using var insert = database.CreateCommand("""
        INSERT INTO depot_reservations (workspace, booked_on, bay, start_hour, reference)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (workspace, booked_on, bay, start_hour) DO NOTHING
        RETURNING id
        """);
    insert.Parameters.Add(new NpgsqlParameter { Value = workspace });
    insert.Parameters.Add(new NpgsqlParameter { Value = request.Date });
    insert.Parameters.Add(new NpgsqlParameter { Value = request.Bay });
    insert.Parameters.Add(new NpgsqlParameter { Value = request.Hour });
    insert.Parameters.Add(new NpgsqlParameter { Value = reference });

    if (await insert.ExecuteScalarAsync(cancellation) is not long id)
        return Results.Conflict(new { message = "This slot was just booked. Choose another time." });

    return Results.Json(new Booking(id, request.Bay, request.Hour, reference), statusCode: 201);
});

app.MapPost("/api/bookings/{id:long}/move", async Task<IResult> (long id, MoveRequest request, HttpContext context, CancellationToken cancellation) =>
{
    if (!ReadWorkspace(context, out var workspace))
        return Results.Json(new { message = "Refresh the schedule to start a workspace." }, statusCode: 401);

    var now = NowInLondon();
    if (SlotError(request.Date, request.Bay, request.Hour, now) is { } error)
        return Results.BadRequest(new { message = error });

    // A fresh identity makes actions from tabs holding the previous booking ID stale.
    await using var move = database.CreateCommand("""
        WITH source AS (
            SELECT id, booked_on, bay, start_hour FROM depot_reservations
            WHERE id = $1 AND workspace = $2
              AND (booked_on > $3 OR (booked_on = $3 AND start_hour > $4))
            FOR UPDATE
        ), moved AS (
            UPDATE depot_reservations AS booking
            SET id = DEFAULT, bay = $6, start_hour = $7
            FROM source
            WHERE booking.id = source.id AND source.booked_on = $5
              AND (source.bay, source.start_hour) <> ($6, $7)
            RETURNING booking.id, booking.bay, booking.start_hour, booking.reference
        )
        SELECT moved.id, moved.bay, moved.start_hour, moved.reference
        FROM source LEFT JOIN moved ON true
        """);
    move.Parameters.Add(new NpgsqlParameter { Value = id });
    move.Parameters.Add(new NpgsqlParameter { Value = workspace });
    move.Parameters.Add(new NpgsqlParameter { Value = DateOnly.FromDateTime(now) });
    move.Parameters.Add(new NpgsqlParameter { Value = now.Hour });
    move.Parameters.Add(new NpgsqlParameter { Value = request.Date });
    move.Parameters.Add(new NpgsqlParameter { Value = request.Bay });
    move.Parameters.Add(new NpgsqlParameter { Value = request.Hour });

    try
    {
        await using var rows = await move.ExecuteReaderAsync(cancellation);
        if (!await rows.ReadAsync(cancellation))
            return Results.NotFound(new { message = "This booking is no longer available to move." });
        if (rows.IsDBNull(0))
            return Results.BadRequest(new { message = "Choose a different bay or hour on the same day." });
        return Results.Json(new Booking(rows.GetInt64(0), rows.GetInt16(1), rows.GetInt16(2), rows.GetString(3)), statusCode: 201);
    }
    catch (PostgresException exception) when (exception.SqlState is PostgresErrorCodes.UniqueViolation or PostgresErrorCodes.DeadlockDetected)
    {
        return Results.Conflict(new { message = "This slot was just booked. Choose another time." });
    }
});

app.MapDelete("/api/bookings/{id:long}", async Task<IResult> (long id, HttpContext context, CancellationToken cancellation) =>
{
    if (!ReadWorkspace(context, out var workspace))
        return Results.Json(new { message = "Refresh the schedule to start a workspace." }, statusCode: 401);

    var now = NowInLondon();
    await using var cancel = database.CreateCommand("""
        DELETE FROM depot_reservations
        WHERE id = $1 AND workspace = $2
          AND (booked_on > $3 OR (booked_on = $3 AND start_hour > $4))
        """);
    cancel.Parameters.Add(new NpgsqlParameter { Value = id });
    cancel.Parameters.Add(new NpgsqlParameter { Value = workspace });
    cancel.Parameters.Add(new NpgsqlParameter { Value = DateOnly.FromDateTime(now) });
    cancel.Parameters.Add(new NpgsqlParameter { Value = now.Hour });
    return await cancel.ExecuteNonQueryAsync(cancellation) == 1
        ? Results.NoContent()
        : Results.NotFound(new { message = "This booking is no longer available to cancel." });
});

await app.RunAsync();

record BookingRequest(DateOnly Date, int Bay, int Hour, string? Reference);
record MoveRequest(DateOnly Date, int Bay, int Hour);
record Booking(long Id, int Bay, int Hour, string Reference);
