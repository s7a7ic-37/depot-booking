export type Booking = { id: number; bay: number; hour: number; reference: string };
export type BookingInput = Omit<Booking, "id"> & { date: string };
export type Board = {
  date: string;
  firstDay: string;
  lastDay: string;
  bayCount: number;
  firstHour: number;
  lastHour: number;
  availableFrom: number;
  bookings: Booking[];
};

const bayCount = 3;
const firstHour = 8;
const lastHour = 16;
const dateFormat = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/London", dateStyle: "short" });
const hourFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", hour: "numeric", hourCycle: "h23",
});
const addDays = (date: string, days: number) => {
  const day = new Date(date + "T00:00:00Z");
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
};

function schedule(requested?: string) {
  const now = new Date();
  const firstDay = dateFormat.format(now);
  const currentHour = Number(hourFormat.format(now));
  const lastDay = addDays(firstDay, 14);
  const date = requested || (currentHour >= lastHour ? addDays(firstDay, 1) : firstDay);
  const parsed = new Date(date + "T00:00:00Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date ||
      date < firstDay || date > lastDay) {
    throw new Error("Choose a date within the next 14 days.");
  }
  const availableFrom = date === firstDay ? Math.max(firstHour, currentHour + 1) : firstHour;
  return { date, firstDay, lastDay, bayCount, firstHour, lastHour, availableFrom };
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("depot-booking-demo", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("bookings", { keyPath: ["date", "bay", "hour"] });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function demoBoard(date?: string): Promise<Board> {
  const board = schedule(date);
  const db = await openDatabase();
  try {
    const bookings = await new Promise<Booking[]>((resolve, reject) => {
      const range = IDBKeyRange.bound([board.date, 1, firstHour], [board.date, bayCount, lastHour]);
      const request = db.transaction("bookings").objectStore("bookings").getAll(range);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return { ...board, bookings };
  } finally {
    db.close();
  }
}

export async function demoReserve(input: BookingInput): Promise<Response> {
  const { date, bay, hour } = input;
  const board = schedule(date);
  if (!Number.isInteger(bay) || bay < 1 || bay > bayCount ||
      !Number.isInteger(hour) || hour < board.availableFrom || hour > lastHour) {
    return Response.json({ message: "Choose an available bay and hour." }, { status: 400 });
  }
  const reference = input.reference.trim();
  if (!/^[A-Za-z0-9 -]{1,32}$/.test(reference)) {
    return Response.json({ message: "Use 1 to 32 letters, numbers, spaces or hyphens for the load reference." }, { status: 400 });
  }
  const db = await openDatabase();
  const booking = { date, bay, hour, id: bay * 24 + hour, reference };
  try {
    return await new Promise<Response>((resolve, reject) => {
      const transaction = db.transaction("bookings", "readwrite");
      const request = transaction.objectStore("bookings").add(booking);
      transaction.oncomplete = () => resolve(Response.json(booking, { status: 201 }));
      transaction.onabort = () => request.error?.name === "ConstraintError"
        ? resolve(Response.json({ message: "This slot was just booked. Choose another time." }, { status: 409 }))
        : reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
