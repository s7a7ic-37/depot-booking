using Npgsql;

const int bayCount = 3;
const int firstHour = 8;
const int lastHour = 16;
const int bookingHorizon = 14;
var london = TimeZoneInfo.FindSystemTimeZoneById("Europe/London");
DateTime NowInLondon() => TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, london).DateTime;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddProblemDetails();
var connectionString = builder.Configuration.GetConnectionString("Depot")
    ?? throw new InvalidOperationException("Set ConnectionStrings__Depot for your local PostgreSQL database.");
await using var database = NpgsqlDataSource.Create(connectionString);
await using (var setup = database.CreateCommand("""
    CREATE TABLE IF NOT EXISTS bay_bookings (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        booked_on date NOT NULL,
        bay smallint NOT NULL CHECK (bay BETWEEN 1 AND 3),
        start_hour smallint NOT NULL CHECK (start_hour BETWEEN 8 AND 16),
        reference text NOT NULL CHECK (length(reference) BETWEEN 1 AND 32),
        UNIQUE (booked_on, bay, start_hour)
    )
    """))
{
    await setup.ExecuteNonQueryAsync();
}

var app = builder.Build();
app.UseExceptionHandler();
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/api/board", async Task<IResult> (DateOnly? date, CancellationToken cancellation) =>
{
    var now = NowInLondon();
    var firstDay = DateOnly.FromDateTime(now);
    var lastDay = firstDay.AddDays(bookingHorizon);
    var day = date ?? (now.Hour >= lastHour ? firstDay.AddDays(1) : firstDay);
    if (day < firstDay || day > lastDay)
        return Results.BadRequest(new { message = "Choose a date within the next 14 days." });

    await using var query = database.CreateCommand("""
        SELECT id, bay, start_hour, reference
        FROM bay_bookings WHERE booked_on = $1 ORDER BY bay, start_hour
        """);
    query.Parameters.Add(new NpgsqlParameter { Value = day });
    await using var rows = await query.ExecuteReaderAsync(cancellation);
    var bookings = new List<Booking>();
    while (await rows.ReadAsync(cancellation))
        bookings.Add(new Booking(rows.GetInt64(0), rows.GetInt16(1), rows.GetInt16(2), rows.GetString(3)));

    var availableFrom = day == firstDay ? Math.Max(firstHour, now.Hour + 1) : firstHour;
    return Results.Ok(new { date = day, firstDay, lastDay, bayCount, firstHour, lastHour, availableFrom, bookings });
});

app.MapPost("/api/bookings", async Task<IResult> (BookingRequest request, CancellationToken cancellation) =>
{
    var now = NowInLondon();
    var today = DateOnly.FromDateTime(now);
    if (request.Date < today || request.Date > today.AddDays(bookingHorizon))
        return Results.BadRequest(new { message = "Choose a date within the next 14 days." });
    if (request.Bay is < 1 or > bayCount || request.Hour is < firstHour or > lastHour)
        return Results.BadRequest(new { message = "Choose an available bay and hour." });
    if (request.Date == today && request.Hour <= now.Hour)
        return Results.BadRequest(new { message = "That hour has already started. Choose a later time." });

    var reference = request.Reference?.Trim();
    if (reference is null || reference.Length is < 1 or > 32 ||
        reference.Any(c => !char.IsAsciiLetterOrDigit(c) && c != '-' && c != ' '))
        return Results.BadRequest(new { message = "Use 1 to 32 letters, numbers, spaces or hyphens for the load reference." });

    await using var insert = database.CreateCommand("""
        INSERT INTO bay_bookings (booked_on, bay, start_hour, reference)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (booked_on, bay, start_hour) DO NOTHING
        RETURNING id
        """);
    insert.Parameters.Add(new NpgsqlParameter { Value = request.Date });
    insert.Parameters.Add(new NpgsqlParameter { Value = request.Bay });
    insert.Parameters.Add(new NpgsqlParameter { Value = request.Hour });
    insert.Parameters.Add(new NpgsqlParameter { Value = reference });

    if (await insert.ExecuteScalarAsync(cancellation) is not long id)
        return Results.Conflict(new { message = "This slot was just booked. Choose another time." });

    return Results.Json(new Booking(id, request.Bay, request.Hour, reference), statusCode: 201);
});

await app.RunAsync();

record BookingRequest(DateOnly Date, int Bay, int Hour, string? Reference);
record Booking(long Id, int Bay, int Hour, string Reference);
