// Tiny JSON-file database. Fine for one team; swap for Postgres if you go multi-tenant.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const FILE = path.join(DATA_DIR, 'db.json');
const EMPTY = { projects: [], threads: [], replies: [], rulesCache: {}, log: [], meta: { lastPostAt: 0 } };

let db = null;
let timer = null;

export function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    db = { ...structuredClone(EMPTY), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    db = structuredClone(EMPTY);
  }
  return db;
}

export function getDb() {
  return db || load();
}

export function save() {
  clearTimeout(timer);
  timer = setTimeout(flush, 150);
}

export function flush() {
  if (!db) return;
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE);
}

export const newId = (prefix = '') => prefix + crypto.randomBytes(6).toString('hex');
export const token = () => crypto.randomBytes(16).toString('hex');

export function log(projectId, msg, level = 'info') {
  const d = getDb();
  d.log.unshift({ at: Date.now(), projectId, level, msg });
  d.log = d.log.slice(0, 1000);
  save();
  console.log(`[${level}] ${projectId || '-'} ${msg}`);
}

process.on('exit', flush);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flush(); process.exit(0); });
