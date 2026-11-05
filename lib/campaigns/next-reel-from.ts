// Display helpers for a next-reel campaign's "bind from" time (the stored
// nextReelArmedAt). Only a future time is a schedule the user set; a past one is
// just the moment the campaign was switched on.

/** The stored reference when it is still ahead of `now`, otherwise null. */
export function scheduledNextReelFrom(
  armedAt: string | Date | null | undefined,
  now: Date = new Date()
): Date | null {
  if (!armedAt) return null;
  const time = new Date(armedAt);
  if (Number.isNaN(time.getTime())) return null;
  return time.getTime() > now.getTime() ? time : null;
}

/** A date as the local "YYYY-MM-DDTHH:mm" value a datetime-local input takes. */
export function toDateTimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Short local date and time, e.g. "05/11/2026, 17:55". */
export function formatNextReelFrom(date: Date): string {
  return date.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}
