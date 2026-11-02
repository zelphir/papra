const DOCUMENT_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MIN_DOCUMENT_DATE = '1900-01-01';

/**
 * Turns an AI suggested date (YYYY-MM-DD) into the document date.
 * The date is stored at noon UTC so that it shows the same calendar day for users in any timezone between UTC-11 and UTC+11.
 * Returns undefined when the suggestion is not a real date between 1900-01-01 and today (UTC).
 */
export function parseDocumentDate({ value, now }: { value: string | null; now: Date }) {
  if (value === null || !DOCUMENT_DATE_REGEX.test(value)) {
    return undefined;
  }

  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  // A JS Date silently rolls impossible dates over (2026-02-30 becomes March 2), so the parts must round-trip
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  const isRealDate =
    utcDate.getUTCFullYear() === year &&
    utcDate.getUTCMonth() === month - 1 &&
    utcDate.getUTCDate() === day;

  // Zero-padded YYYY-MM-DD strings compare in calendar order
  const today = now.toISOString().slice(0, 10);
  if (!isRealDate || value < MIN_DOCUMENT_DATE || value > today) {
    return undefined;
  }

  return new Date(`${value}T12:00:00.000Z`);
}
