// Consistent online backup of the SQLite database plus the uploads folder.
//   node scripts/backup.mjs [destDir]        (default ./backups)
// Safe while web and worker are running: uses SQLite's online backup API, not a file copy.
// Keeps the newest KEEP backups (default 14). Run nightly from cron or the host's task scheduler.
import Database from "better-sqlite3";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const url = process.env.DATABASE_URL ?? "file:./data/canvass.db";
const source = path.resolve(url.replace(/^file:/, ""));
const uploads = path.resolve(process.env.UPLOAD_DIR ?? path.join(path.dirname(source), "uploads"));
const dest = path.resolve(process.argv[2] ?? "backups");
const keep = Number(process.env.KEEP ?? 14);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = path.join(dest, `canvass-${stamp}`);
mkdirSync(dir, { recursive: true });

const db = new Database(source, { readonly: true, fileMustExist: true });
await db.backup(path.join(dir, "canvass.db"));
db.close();
if (existsSync(uploads)) cpSync(uploads, path.join(dir, "uploads"), { recursive: true });
console.log(`Backed up to ${dir}`);

const old = readdirSync(dest).filter((n) => n.startsWith("canvass-")).sort().slice(0, -keep);
for (const n of old) rmSync(path.join(dest, n), { recursive: true, force: true });
if (old.length) console.log(`Removed ${old.length} old backup(s)`);
