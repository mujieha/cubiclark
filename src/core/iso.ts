// The one form a time may take when it is read from a file someone else could have written (R4-3): an ISO
// instant in UTC, as `new Date().toISOString()` writes it and as Claude Code writes its own. A parser such
// as Date.parse also accepts a free-text comment (`Oct 3 2026 10:00:00 GMT (...)`), which would carry any
// text into every event, so the text itself is checked, not only whether it parses.

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

/** True for an ISO instant of at most 24 characters that names a date that exists. */
export function isIsoInstant(text: string): boolean {
  return ISO_INSTANT.test(text) && !Number.isNaN(Date.parse(text))
}
