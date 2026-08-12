/**
 * Default IANA timezone used everywhere a user/project has not explicitly set
 * one. Global (not project-specific): the app schedules crons and renders
 * timestamps in IST by default while the DB keeps storing UTC.
 */
export const DEFAULT_TIMEZONE = "Asia/Kolkata";

/**
 * Renders an ISO/Date timestamp in the given IANA timezone as a 12-hour local
 * date & time (e.g. "Aug 11, 2026, 4:12 PM"). Falls back to the device-local
 * timezone if `timezone` is invalid.
 */
export function formatDateTimeLocal(
  value: Date | string,
  timezone: string,
): string {
  const date = typeof value === "string" ? new Date(value) : value;
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(date);
  }
}
