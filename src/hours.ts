export type ShanghaiClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: string;
};

const OPEN = 9 * 60;
const CLOSE = 18 * 60 + 30;

export function shanghaiNow(now = Date.now()): ShanghaiClock {
  const bag = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai",
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(new Date(now))
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: Number(bag.hour) % 24,
    minute: Number(bag.minute),
    weekday: bag.weekday,
  };
}

function stamp(year: number, month: number, day: number, hour: number, minute: number): number {
  return Date.UTC(year, month - 1, day, hour - 8, minute, 0, 0);
}

export function inOffHours(now = Date.now()): boolean {
  const clock = shanghaiNow(now);
  if (clock.weekday === "Sat" || clock.weekday === "Sun") return true;
  const mins = clock.hour * 60 + clock.minute;
  return mins < OPEN || mins >= CLOSE;
}

export function nextOffAt(now = Date.now()): number {
  const clock = shanghaiNow(now);
  const mins = clock.hour * 60 + clock.minute;
  const weekend = clock.weekday === "Sat" || clock.weekday === "Sun";
  if (!weekend && mins < CLOSE) return stamp(clock.year, clock.month, clock.day, 18, 30);
  const tomorrow = shanghaiNow(stamp(clock.year, clock.month, clock.day, 0, 0) + 24 * 60 * 60 * 1000);
  return stamp(tomorrow.year, tomorrow.month, tomorrow.day, 0, 0);
}
