// One-off: fill events.starts_on from the free-text events.date for rows where it is still NULL.
// NOT a migration and NOT run automatically. Prints SQL (default) or a report; run the SQL yourself after reading it.
//
//   node scripts/backfill-starts-on.mjs rows.json            # rows.json = output of the SELECT below; prints a report + UPDATE statements
//   npx wrangler d1 execute esports-db --remote --json --command "SELECT id, owner_id, name, date FROM events WHERE starts_on IS NULL AND date != '' LIMIT 1000" > rows.json
//
// Chunk by LIMIT 1000 and run after 00:00 UTC (one write per parsed row). Unparseable rows stay NULL and are listed for the owner.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

function iso(y, m, d) {
  if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const s = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const t = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s ? s : null;
}

/** Tolerant, pure. Returns YYYY-MM-DD or null. A range ("12-14 Dec 2026") uses its first day. Day-first only (DD/MM/YYYY); never guesses month-first. */
export function parseLooseDate(text) {
  const s = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return iso(+m[3], +m[2], +m[1]);
  m = /^(\d{1,2})(?:st|nd|rd|th)?(?:\s*[-–]\s*\d{1,2}(?:st|nd|rd|th)?)?,? ([A-Za-z]{3,9})\.?,? (\d{4})$/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) return iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  m = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?(?:\s*[-–]\s*\d{1,2})?,? (\d{4})$/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) return iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  return null;
}

function main(file) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const rows = Array.isArray(raw) && raw[0]?.results ? raw[0].results : raw;
  const parsed = [];
  const unparsed = [];
  for (const r of rows) {
    const v = parseLooseDate(r.date);
    (v ? parsed : unparsed).push({ ...r, v });
  }
  for (const r of parsed) console.log(`UPDATE events SET starts_on = '${r.v}' WHERE id = '${String(r.id).replace(/'/g, "''")}' AND starts_on IS NULL;`);
  console.error(`parsed ${parsed.length}, unparsed ${unparsed.length} (stay NULL: shown as "date not set" until the owner edits)`);
  for (const r of unparsed) console.error(`  unparsed: owner ${r.owner_id} event ${r.id} date ${JSON.stringify(r.date)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!process.argv[2]) { console.error("usage: node scripts/backfill-starts-on.mjs rows.json"); process.exit(2); }
  main(process.argv[2]);
}
