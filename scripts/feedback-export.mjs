#!/usr/bin/env node
/**
 * Prints the on-page feedback reports as Markdown, grouped by page, newest first. Read-only. Works while the admin console is off.
 *
 * Usage (from the esports-backend folder, after `npx wrangler login`):
 *   node scripts/feedback-export.mjs --db staging              reports with status "new" from staging
 *   node scripts/feedback-export.mjs --db production --status all --limit 500
 *   node scripts/feedback-export.mjs --db production > feedback.md
 *
 * Options:
 *   --db staging|production        which database (default: production). Staging uses `--env staging` (esports-db-staging).
 *   --status new|triaged|fixed|wontfix|all   which status (default: new)
 *   --limit N                      at most N reports, 1..2000 (default: 200)
 *
 * It runs `wrangler d1 execute <db> --remote [--env staging] --json` with one constant SELECT (status and limit are validated, never pasted raw).
 * Output holds: page, kind, message, device, viewport, locale, status, client errors, id, date. It never prints the contact, the account id, the
 * address hash or screenshot bytes (read those through the staff API, or by id with wrangler). Reports are plain text: the Markdown escapes backticks.
 */
import { spawnSync } from "node:child_process";

const STATUSES = ["new", "triaged", "fixed", "wontfix", "all"];
const DBS = { production: { name: "esports-db", env: null }, staging: { name: "esports-db-staging", env: "staging" } };

export function parseArgs(argv) {
  const o = { db: "production", status: "new", limit: 200 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--db") { o.db = v; i++; }
    else if (a === "--status") { o.status = v; i++; }
    else if (a === "--limit") { o.limit = Number(v); i++; }
    else if (a === "--help" || a === "-h") { o.help = true; }
    else throw new Error(`Unknown option ${a}`);
  }
  if (!DBS[o.db]) throw new Error("--db must be staging or production");
  if (!STATUSES.includes(o.status)) throw new Error(`--status must be one of ${STATUSES.join(", ")}`);
  if (!Number.isInteger(o.limit) || o.limit < 1 || o.limit > 2000) throw new Error("--limit must be a whole number from 1 to 2000");
  return o;
}

export function buildSql(o) {
  // status and limit are validated above (closed list, integer), so inlining them is safe.
  const where = o.status === "all" ? "" : `WHERE status = '${o.status}'`;
  return `SELECT id, created_at, kind, message, page_path, viewport_w, viewport_h, device_class, browser_family, locale, status, client_errors FROM feedback_reports ${where} ORDER BY created_at DESC, id DESC LIMIT ${o.limit}`;
}

const md = (s) => String(s ?? "").replace(/`/g, "'").replace(/\r?\n/g, "\n  > ");

export function toMarkdown(rows, o) {
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.page_path)) groups.set(r.page_path, []);
    groups.get(r.page_path).push(r);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const out = [`# Feedback (${o.db}, status: ${o.status}) - ${rows.length} report${rows.length === 1 ? "" : "s"} on ${groups.size} page${groups.size === 1 ? "" : "s"}`, ""];
  for (const [page, list] of ordered) {
    out.push(`## \`${page}\` (${list.length})`, "");
    for (const r of list) {
      let errs = [];
      try { errs = r.client_errors ? JSON.parse(r.client_errors) : []; } catch { errs = []; }
      const date = new Date(r.created_at * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
      out.push(`- **${r.kind}** (${r.status}) - ${date}`);
      out.push(`  > ${md(r.message)}`);
      out.push(`  - device: ${r.device_class ?? "unknown"} / ${r.browser_family ?? "other"}, viewport ${r.viewport_w ?? "?"}x${r.viewport_h ?? "?"}, locale ${r.locale ?? "-"}`);
      if (errs.length) out.push(`  - client errors: ${errs.map((e) => `\`${md(e)}\``).join("; ")}`);
      out.push(`  - id: \`${r.id}\``);
    }
    out.push("");
  }
  if (!rows.length) out.push("_No reports._", "");
  return out.join("\n");
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log("Usage: node scripts/feedback-export.mjs --db staging|production [--status new|triaged|fixed|wontfix|all] [--limit 200]");
    return;
  }
  const db = DBS[o.db];
  const args = ["wrangler", "d1", "execute", db.name, "--remote", ...(db.env ? ["--env", db.env] : []), "--json", "--command", process.platform === "win32" ? `"${buildSql(o)}"` : buildSql(o)]; // the SQL has no double quotes; on Windows the shell needs the quotes to keep it one argument
  const r = spawnSync("npx", args, { encoding: "utf8", shell: process.platform === "win32", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error(`wrangler failed (exit ${r.status}). Are you logged in (npx wrangler login) and is migration 0054 applied to ${o.db}?`);
    console.error((r.stderr ?? "").split("\n").slice(-8).join("\n"));
    process.exit(1);
  }
  const text = r.stdout ?? "";
  const start = text.indexOf("[");
  let parsed;
  try { parsed = JSON.parse(text.slice(start)); } catch { console.error("Could not read wrangler's JSON output."); process.exit(1); }
  const rows = parsed?.[0]?.results ?? [];
  console.log(toMarkdown(rows, o));
}

if (process.argv[1] && /feedback-export\.mjs$/.test(process.argv[1])) main();
