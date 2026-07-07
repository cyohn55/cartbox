/**
 * Game jam scheduling logic. Pure so the same status drives the UI, the API's
 * submission guard, and tests.
 */

/** Lifecycle state of a jam relative to a point in time. */
export type JamStatus = "upcoming" | "open" | "closed";

/**
 * Determines a jam's status at a given moment.
 *
 * Boundaries are inclusive of the start and exclusive of the end: a jam is
 * "open" during [startsAt, endsAt).
 *
 * @param now The reference time (defaults to the current time).
 * @param startsAt When submissions open.
 * @param endsAt When submissions close.
 */
export function jamStatus(startsAt: Date, endsAt: Date, now: Date = new Date()): JamStatus {
  if (endsAt <= startsAt) {
    throw new RangeError("Jam endsAt must be after startsAt");
  }
  if (now < startsAt) {
    return "upcoming";
  }
  if (now < endsAt) {
    return "open";
  }
  return "closed";
}

/** Whether new entries may be submitted to a jam right now. */
export function isSubmissionOpen(startsAt: Date, endsAt: Date, now: Date = new Date()): boolean {
  return jamStatus(startsAt, endsAt, now) === "open";
}
