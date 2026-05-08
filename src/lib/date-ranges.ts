/**
 * Parses a YYYY-MM-DD string as midnight UTC, avoiding timezone offset issues.
 */
export function parseFechaUTC(str: string): Date {
  const [year, month, day] = str.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0))
}

/**
 * Returns start (inclusive) and end (exclusive) UTC boundaries for a date range.
 * If only `from` is provided, end defaults to end-of-day UTC of `from`.
 */
export function buildDateRange(from: string, to?: string): { start: Date; end: Date } {
  const start = parseFechaUTC(from)
  const end = to
    ? parseFechaUTC(to)
    : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 1))
  return { start, end }
}
