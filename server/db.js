// Local document store that stands in for the claude.ai artifact `db` capability.
// JSON documents at slash-separated paths (collection/doc, nested collection/doc/sub/doc),
// kept in memory and persisted as one file per document under data/db/docs.
import fs from "node:fs";
import path from "node:path";

const SEG = /^[A-Za-z0-9_\-.~:@+]+$/;

export class DbError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function checkPath(p, kind) {
  if (typeof p !== "string" || !p) throw new DbError("invalid_argument", "path must be a non-empty string");
  const segs = p.split("/");
  for (const s of segs) if (!SEG.test(s) || s === "." || s === "..") throw new DbError("invalid_argument", `bad path segment "${s}"`);
  if (segs.length > 16 || p.length > 1000) throw new DbError("invalid_argument", "path too long");
  if (kind === "doc" && segs.length % 2) throw new DbError("invalid_argument", `document paths need an even number of segments: ${p}`);
  if (kind === "col" && !(segs.length % 2)) throw new DbError("invalid_argument", `collection paths need an odd number of segments: ${p}`);
  return segs;
}
const parentOf = (p) => p.slice(0, p.lastIndexOf("/"));
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

function cmp(a, b) {
  if (a === b) return 0;
  if (a === undefined || a === null) return 1;
  if (b === undefined || b === null) return -1;
  if (typeof a === typeof b) return a < b ? -1 : 1;
  return String(a) < String(b) ? -1 : 1;
}
function matches(data, [field, op, value]) {
  const v = data[field];
  switch (op) {
    case "==": return v === value;
    case "!=": return v !== value;
    case "<": return v != null && v < value;
    case "<=": return v != null && v <= value;
    case ">": return v != null && v > value;
    case ">=": return v != null && v >= value;
    case "in": return Array.isArray(value) && value.includes(v);
    case "not-in": return Array.isArray(value) && !value.includes(v);
    case "array-contains": return Array.isArray(v) && v.includes(value);
    default: throw new DbError("invalid_argument", `unknown operator ${op}`);
  }
}

export class DocStore {
  constructor(dir, { maxDocBytes = 8 * 1024 * 1024 } = {}) {
    this.dir = dir; this.docDir = path.join(dir, "docs"); this.backupDir = path.join(dir, "backups");
    this.maxDocBytes = maxDocBytes;
    this.docs = new Map();      // path -> { data, v, t }
    this.byCol = new Map();     // collection path -> Set(doc path)
    this.leases = new Map();    // path -> { holder, exp }
    this.pending = new Map();   // path -> timer
    this.listeners = new Set();
    this.version = 0; this.seq = 0;
    fs.mkdirSync(this.docDir, { recursive: true });
    fs.mkdirSync(this.backupDir, { recursive: true });
    this.load();
  }
  fileOf(p) { return path.join(this.docDir, encodeURIComponent(p) + ".json"); }
  load() {
    let n = 0;
    for (const f of fs.readdirSync(this.docDir)) {
      if (!f.endsWith(".json")) continue;
      const p = decodeURIComponent(f.slice(0, -5));
      try { const raw = JSON.parse(fs.readFileSync(path.join(this.docDir, f), "utf8")); this.index(p, { data: raw.data ?? raw, v: raw.v || 1, t: raw.t || 0 }); this.seq = Math.max(this.seq, raw.v || 1); n++; }
      catch (e) { console.warn(`[db] skipped unreadable ${f}: ${e.message}`); }
    }
    console.log(`[db] loaded ${n} documents from ${this.docDir}`);
  }
  index(p, rec) {
    this.docs.set(p, rec);
    const c = parentOf(p); if (!this.byCol.has(c)) this.byCol.set(c, new Set()); this.byCol.get(c).add(p);
  }
  unindex(p) { this.docs.delete(p); this.byCol.get(parentOf(p))?.delete(p); }
  persist(p) {
    clearTimeout(this.pending.get(p));
    this.pending.set(p, setTimeout(() => this.flushOne(p), 250));
  }
  flushOne(p) {
    this.pending.delete(p);
    const rec = this.docs.get(p); const f = this.fileOf(p);
    try {
      if (!rec) { fs.rmSync(f, { force: true }); return; }
      const tmp = f + ".tmp"; fs.writeFileSync(tmp, JSON.stringify({ v: rec.v, t: rec.t, data: rec.data })); fs.renameSync(tmp, f);
    } catch (e) { console.error(`[db] write failed for ${p}: ${e.message}`); }
  }
  flushAll() { for (const p of [...this.pending.keys()]) { clearTimeout(this.pending.get(p)); this.flushOne(p); } }
  emit(paths) { this.version++; for (const fn of this.listeners) { try { fn(paths, this.version); } catch (e) { /* listener gone */ } } }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  get(p) { checkPath(p, "doc"); const r = this.docs.get(p); return r ? { exists: true, data: r.data, v: r.v } : { exists: false }; }
  set(p, data) {
    checkPath(p, "doc");
    if (!isObj(data)) throw new DbError("invalid_argument", "document body must be a JSON object");
    const size = Buffer.byteLength(JSON.stringify(data));
    if (size > this.maxDocBytes) throw new DbError("invalid_argument", `document ${p} is ${size} bytes, over the ${this.maxDocBytes} byte limit`);
    this.index(p, { data, v: ++this.seq, t: Date.now() });
    this.persist(p); this.emit([p]);
  }
  update(p, patch) {
    checkPath(p, "doc");
    const prev = this.docs.get(p); if (!prev) throw new DbError("invalid_argument", `update needs an existing document: ${p}`);
    if (!isObj(patch)) throw new DbError("invalid_argument", "update body must be a JSON object");
    this.set(p, deepMerge(prev.data, patch));
  }
  delete(p) { checkPath(p, "doc"); if (!this.docs.has(p)) return; this.unindex(p); this.persist(p); this.emit([p]); }
  query(col, { where = [], orderBy = null, limit = null } = {}) {
    checkPath(col, "col");
    if (where.length > 10) throw new DbError("invalid_argument", "at most 10 filters");
    let rows = [...(this.byCol.get(col) || [])].map((p) => ({ id: p.slice(p.lastIndexOf("/") + 1), path: p, data: this.docs.get(p).data }));
    for (const w of where) rows = rows.filter((r) => matches(r.data, w));
    if (orderBy) { const [f, dir] = orderBy; const s = dir === "desc" ? -1 : 1; rows.sort((a, b) => { const x = a.data[f], y = b.data[f]; if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return s * cmp(x, y); }); }
    else rows.sort((a, b) => cmp(a.id, b.id));
    if (limit) rows = rows.slice(0, Math.max(1, Math.min(5000, limit)));
    return rows;
  }
  acquire(p, { holder, ttlMs = 30000, data } = {}) {
    checkPath(p, "doc");
    if (!holder) throw new DbError("invalid_argument", "acquire needs a holder");
    const ttl = Math.max(1000, Math.min(600000, ttlMs || 30000)); const now = Date.now();
    const cur = this.leases.get(p);
    if (cur && cur.exp > now && cur.holder !== holder) return { acquired: false, expiresAt: new Date(cur.exp).toISOString() };
    const exp = now + ttl; this.leases.set(p, { holder, exp });
    if (isObj(data)) this.set(p, { ...(this.docs.get(p)?.data || {}), ...data });
    return { acquired: true, version: this.docs.get(p)?.v || 0, expiresAt: new Date(exp).toISOString(), holder };
  }

  /* ----- memory maintenance ----- */
  stats() {
    const cols = {}; let bytes = 0;
    for (const [p, r] of this.docs) { const c = parentOf(p); const b = Buffer.byteLength(JSON.stringify(r.data)); cols[c] = cols[c] || { n: 0, bytes: 0 }; cols[c].n++; cols[c].bytes += b; bytes += b; }
    const backups = this.listBackups();
    return { docs: this.docs.size, bytes, collections: cols, backups: backups.slice(0, 5), dir: this.dir };
  }
  dump() { const out = {}; for (const [p, r] of this.docs) out[p] = r.data; return { format: "tapewire-db", version: 1, exportedAt: new Date().toISOString(), docs: out }; }
  restore(dump, { replace = false } = {}) {
    if (!dump || dump.format !== "tapewire-db" || !isObj(dump.docs)) throw new DbError("invalid_argument", "not a Tapewire backup file");
    if (replace) for (const p of [...this.docs.keys()]) if (!(p in dump.docs)) { this.unindex(p); this.persist(p); }
    let n = 0; const changed = [];
    for (const [p, data] of Object.entries(dump.docs)) { try { checkPath(p, "doc"); if (!isObj(data)) continue; this.index(p, { data, v: ++this.seq, t: Date.now() }); this.persist(p); changed.push(p); n++; } catch (e) { /* skip bad path */ } }
    this.emit(changed); return n;
  }
  listBackups() { try { return fs.readdirSync(this.backupDir).filter((f) => f.endsWith(".json")).sort().reverse(); } catch (e) { return []; } }
  backup(keep = 14) {
    const name = `tapewire-${new Date().toISOString().slice(0, 10)}.json`; const f = path.join(this.backupDir, name);
    fs.writeFileSync(f + ".tmp", JSON.stringify(this.dump())); fs.renameSync(f + ".tmp", f);
    for (const old of this.listBackups().slice(keep)) fs.rmSync(path.join(this.backupDir, old), { force: true });
    return name;
  }
}
