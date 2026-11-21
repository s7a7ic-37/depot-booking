import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { demoBoard, demoCancel, demoMove, demoReserve } from "./demo";
import type { Board, Booking, BookingInput, Slot } from "./demo";
import "./style.css";

const browserDemo = import.meta.env.MODE === "demo";
const clockLabel = (hour: number) => String(hour).padStart(2, "0") + ":00";
const dayLabel = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });

function downloadDay(date: string, bookings: Booking[]) {
  const rows = bookings.map(({ bay, hour, reference }) => {
    // shortcut: the CSV text prefix targets Excel; use typed exports for other importers.
    const text = /^\s*[=+\-@＝＋－＠]/u.test(reference) || /^[\t\r\n]/.test(reference) ? "\t" + reference : reference;
    return [date, bay, clockLabel(hour), '"' + text.replaceAll('"', '""') + '"'].join(",");
  });
  const csv = new Blob(["Date,Bay,Start time (UK),Load reference\r\n", rows.join("\r\n"), "\r\n"],
    { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(csv);
  const link = document.createElement("a");
  link.href = url;
  link.download = "depot-bookings-" + date + ".csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function getBoard(date = ""): Promise<Board> {
  if (browserDemo) return demoBoard(date);
  const params = date ? "?" + new URLSearchParams({ date }) : "";
  const response = await fetch("/api/board" + params, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Could not load the schedule.");
  return response.json();
}

function postBooking(path: string, input: BookingInput | Slot) {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(10_000),
  });
}

function App() {
  const [board, setBoard] = useState<Board | null>(null);
  const [bay, setBay] = useState(1);
  const [hour, setHour] = useState<number | null>(null);
  const [reference, setReference] = useState("");
  const [moving, setMoving] = useState<Booking | null>(null);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  async function loadSchedule(date?: string) {
    setBusy(true);
    setFailed(false);
    setMessage("Loading schedule…");
    try {
      setBoard(await getBoard(date));
      setHour(null);
      setMoving(null);
      setMessage("");
    } catch {
      setFailed(true);
      setMessage("Could not load the schedule. Try again.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void loadSchedule(); }, []);

  async function submitBooking(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !board || hour === null) return;
    setBusy(true);
    setFailed(false);
    setMessage(moving ? "Moving booking…" : "Saving booking…");
    try {
      const slot = { date: board.date, bay, hour };
      const input = { ...slot, reference };
      const response = moving
        ? await (browserDemo ? demoMove(slot, moving) : postBooking(`/api/bookings/${moving.id}/move`, slot))
        : await (browserDemo ? demoReserve(input) : postBooking("/api/bookings", input));
      if (response.status === 409 || (moving && response.status === 404)) {
        setFailed(true);
        setHour(null);
        const current = await getBoard(board.date);
        setBoard(current);
        if (moving && (response.status === 404 || !current.bookings.some((row) => row.id === moving.id))) {
          setMoving(null);
          setMessage("The original booking is no longer available to move. The schedule has been refreshed.");
        } else {
          setMessage(moving ? "That slot is taken. Your original booking is still in place." : "This slot was just booked. Choose another time.");
        }
      } else if (response.ok) {
        const saved: Booking = await response.json();
        const remaining = moving ? board.bookings.filter((row) => row.id !== moving.id) : board.bookings;
        setBoard({ ...board, bookings: [...remaining, saved] });
        setMessage(moving
          ? `Moved ${saved.reference} to bay ${saved.bay} at ${clockLabel(saved.hour)}.`
          : `Booked bay ${saved.bay} at ${clockLabel(saved.hour)} for ${saved.reference}.`);
        setHour(null);
        setMoving(null);
        if (!moving) setReference("");
      } else {
        const error = await response.json().catch(() => null);
        setFailed(true);
        setMessage(error?.message || "Could not confirm the booking. Check the schedule before trying again.");
      }
    } catch {
      setFailed(true);
      setMessage("Could not confirm the booking. Check the schedule before trying again.");
    } finally {
      setBusy(false);
    }
  }

  function startMove(booking: Booking) {
    setMoving(booking);
    setBay(booking.bay);
    setHour(null);
    setFailed(false);
    setMessage("Choose a different bay or time, then confirm the move.");
    document.getElementById("slots-heading")?.focus();
  }

  async function cancel(booking: Booking) {
    if (busy || !board || !window.confirm("Cancel bay " + booking.bay + " at " + clockLabel(booking.hour) + "?")) return;
    setBusy(true);
    setFailed(false);
    setMessage("Cancelling booking…");
    try {
      const response = browserDemo
        ? await demoCancel(board.date, booking)
        : await fetch("/api/bookings/" + booking.id, { method: "DELETE", signal: AbortSignal.timeout(10_000) });
      if (response.status === 204) {
        setBoard({ ...board, bookings: board.bookings.filter((row) => row.id !== booking.id) });
        setMessage("Booking cancelled. The slot is available again.");
      } else {
        setBoard(await getBoard(board.date));
        setFailed(true);
        setMessage("That booking could not be cancelled. The schedule has been refreshed.");
      }
    } catch {
      setFailed(true);
      setMessage("Could not confirm cancellation. Refresh the schedule to check the slot.");
    } finally {
      setBusy(false);
    }
  }

  const hours = board ? Array.from({ length: board.lastHour - board.firstHour + 1 }, (_, i) => board.firstHour + i) : [];
  const bookings = [...(board?.bookings ?? [])].sort((a, b) => a.bay - b.bay || a.hour - b.hour);
  const booked = new Set(bookings.filter((slot) => slot.bay === bay).map((slot) => slot.hour));
  const selection = hour === null ? "Choose a time on the schedule." : "Bay " + bay + " · " + clockLabel(hour) + "–" + clockLabel(hour + 1);

  return <>
    <header><div className="wrap header-line">
      <a className="brand" href="/"><img src="/favicon.svg" alt="" width="28" height="28" />Depot Booking</a>
      <a href="https://portfolio.artemislab.co.uk/#projects">← All projects</a>
    </div></header>
    <main className="wrap">
      <div className="intro">
        <h1>Loading bay schedule</h1>
        <p>{browserDemo ? "Browser demo · Sample bookings stay in this browser." : "Reserve an hour for a delivery or collection."}</p>
      </div>
      <p className="message" role="status" data-failed={failed}>{message || (busy ? "Loading schedule…" : "")}</p>
      {!board && !busy && <button type="button" onClick={() => void loadSchedule()}>Retry schedule</button>}
      {board && <div className="layout">
        <section className="panel" aria-labelledby="slots-heading">
          <div className="date-line">
            <div><label htmlFor="date">Booking date</label>
              <input id="date" type="date" value={board.date} min={board.firstDay} max={board.lastDay}
                disabled={busy} onChange={(event) => { if (event.target.value) void loadSchedule(event.target.value); }} />
            </div>
            <div className="schedule-actions">
              <button type="button" disabled={busy} onClick={() => void loadSchedule(board.date)}>Refresh schedule</button>
              <button type="button" disabled={busy || bookings.length === 0}
                onClick={() => downloadDay(board.date, bookings)}>Download day CSV</button>
            </div>
          </div>
          <div className="bay-list" role="group" aria-label="Loading bay">
            {Array.from({ length: board.bayCount }, (_, i) => i + 1).map((number) =>
              <button key={number} type="button" disabled={busy} aria-pressed={bay === number}
                onClick={() => { setBay(number); setHour(null); }}>Bay {number}</button>
            )}
          </div>
          <h2 id="slots-heading" tabIndex={-1}>Time slots</h2>
          <p className="schedule-date">{dayLabel.format(new Date(board.date + "T00:00:00Z"))} · UK time</p>
          <div className="slots">
            {hours.map((time) => {
              const state = booked.has(time) ? "Booked" : time < board.availableFrom ? "Elapsed" : "Available";
              return <button key={time} type="button" disabled={busy || state !== "Available"}
                aria-label={"Bay " + bay + ", " + clockLabel(time) + ", " + state}
                aria-pressed={hour === time} onClick={() => setHour(time)}>
                <span>{clockLabel(time)}</span><small>{state}</small>
              </button>;
            })}
          </div>
        </section>
        <form className="panel booking-form" onSubmit={submitBooking}>
          <h2>{moving ? "Move booking" : "Reserve a slot"}</h2>
          {moving && <p className="selection">{moving.reference} · Now bay {moving.bay} at {clockLabel(moving.hour)}</p>}
          <p className="selection">{selection}</p>
          {!moving && <><label htmlFor="reference">Load reference</label>
            <input id="reference" name="reference" placeholder="e.g. LOAD-104" maxLength={32} required
              value={reference} disabled={busy} onChange={(event) => setReference(event.target.value)} /></>}
          <button className="primary" disabled={busy || hour === null || (!moving && !reference.trim())}>
            {moving ? "Confirm move" : "Reserve slot"}
          </button>
          {moving && <button className="keep-booking" type="button" disabled={busy} onClick={() => {
            setMoving(null);
            setHour(null);
            setFailed(false);
            setMessage("Your booking is unchanged.");
            document.getElementById("slots-heading")?.focus();
          }}>Keep current booking</button>}
        </form>
        {bookings.length > 0 && <section className="panel bookings" aria-labelledby="bookings-heading">
          <h2 id="bookings-heading">Bookings for this day</h2>
          <ul>
            {bookings.map((booking) => <li key={booking.id}>
              <span><strong>{booking.reference}</strong><small>Bay {booking.bay} · {clockLabel(booking.hour)}</small></span>
              {booking.hour >= board.availableFrom && <div className="booking-actions">
                <button type="button" disabled={busy || moving !== null}
                  aria-label={"Move bay " + booking.bay + " at " + clockLabel(booking.hour)}
                  onClick={() => startMove(booking)}>Move</button>
                <button type="button" disabled={busy || moving !== null}
                  aria-label={"Cancel bay " + booking.bay + " at " + clockLabel(booking.hour)}
                  onClick={() => void cancel(booking)}>Cancel</button>
              </div>}
            </li>)}
          </ul>
        </section>}
      </div>}
    </main>
    <footer className="wrap"><a href="https://github.com/s7a7ic-37/depot-booking">Project source ↗</a></footer>
  </>;
}

createRoot(document.getElementById("app")!).render(<App />);
