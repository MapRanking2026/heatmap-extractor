// Date helpers. The dashboard timeline / compare dropdowns label scans like
// "10th Apr 2026" (ordinal day, short month, year). We generate the same text
// from a scan's ISO timestamp so the automation can select the right option.

const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function ordinal(day) {
  const j = day % 10;
  const k = day % 100;
  if (j === 1 && k !== 11) return `${day}st`;
  if (j === 2 && k !== 12) return `${day}nd`;
  if (j === 3 && k !== 13) return `${day}rd`;
  return `${day}th`;
}

// The dashboard renders scan dates in the browser's local time. We can't know
// that timezone from Node with certainty, so we build the label in UTC and the
// automation also matches loosely (by month+year, nearest day) as a fallback.
export function scanLabel(iso) {
  const d = new Date(iso);
  return `${ordinal(d.getUTCDate())} ${SHORT_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// "Apr 2026" — used for grouping/labelling by month and loose matching.
export function monthLabel(iso) {
  const d = new Date(iso);
  return `${SHORT_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// YYYY-MM, sortable month key.
export function monthKey(iso) {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Filesystem-safe slug for filenames.
export function slug(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "item";
}
