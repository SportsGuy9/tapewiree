// Tapewire local server: serves the page and provides the three runtime capabilities it was built on
// (db, mcp connectors, sample/AI) from this machine. Start with `npm start`, then open http://localhost:8787
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, ROOT } from "./config.js";
import { DocStore, DbError } from "./db.js";
import { makeConnectors, ToolError } from "./connectors.js";
import { makeAi } from "./ai.js";
import { maskedKeys, writeKeys } from "./keys.js";

let cfg = loadConfig();
const db = new DocStore(path.join(cfg.dataDir, "db"));
let connectors = makeConnectors(cfg);
let ai = makeAi(cfg);
/* keys saved from the setup page take effect without a restart */
function reload() { const port = cfg.port, host = cfg.host, dataDir = cfg.dataDir; cfg = { ...loadConfig(), port, host, dataDir }; connectors = makeConnectors(cfg); ai = makeAi(cfg); }
const PUBLIC = path.join(ROOT, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
async function readBody(req, limit = 64 * 1024 * 1024) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new DbError("invalid_argument", "request body too large"); chunks.push(c); }
  const s = Buffer.concat(chunks).toString("utf8"); return s ? JSON.parse(s) : {};
}
function sse(res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
  res.write(": ok\n\n");
  return (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
}

function dbOp(b) {
  switch (b.op) {
    case "get": return db.get(b.path);
    case "set": db.set(b.path, b.data); return { ok: true };
    case "update": db.update(b.path, b.data); return { ok: true };
    case "delete": db.delete(b.path); return { ok: true };
    case "query": return { docs: db.query(b.col, b).map((r) => ({ id: r.id, v: db.docs.get(r.path)?.v || 0, data: r.data })) };
    case "acquire": return db.acquire(b.path, b);
    case "batch": return { results: (b.ops || []).map((o) => { try { return dbOp(o); } catch (e) { return { error: { code: e.code || "invalid_argument", message: e.message } }; } }) };
    default: throw new DbError("invalid_argument", `unknown op ${b.op}`);
  }
}

function backupIfDue() {
  const today = `tapewire-${new Date().toISOString().slice(0, 10)}.json`;
  if (!db.listBackups().includes(today) && db.docs.size) { try { console.log(`[db] backup written: ${db.backup(cfg.backupsKeep)}`); } catch (e) { console.warn(`[db] backup failed: ${e.message}`); } }
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  try {
    // only this app's own pages may change things: blocks other websites from posting to localhost (CSRF)
    if (req.method !== "GET" && p.startsWith("/api/")) {
      const origin = req.headers.origin; const site = req.headers["sec-fetch-site"];
      if ((origin && new URL(origin).host !== req.headers.host) || (site && !["same-origin", "none"].includes(site))) return json(res, 403, { code: "forbidden", message: "Cross-site request refused" });
    }
    if (p === "/api/env.js") {
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      res.end(`window.__TW=${JSON.stringify({ standalone: true, ai: ai.enabled, promptBudget: ai.promptBudget, connectors: connectors.status(), news: connectors.news() })};`); return;
    }
    if (p === "/api/keys" && req.method === "GET") return json(res, 200, { keys: maskedKeys(cfg), status: connectors.status(), news: connectors.news(), ai: ai.enabled });
    if (p === "/api/keys" && req.method === "POST") {
      const b = await readBody(req, 64 * 1024);
      try { const changed = writeKeys(b.values || {}); reload(); console.log(`[keys] updated ${changed.join(", ")}`); return json(res, 200, { changed, keys: maskedKeys(cfg), status: connectors.status(), news: connectors.news(), ai: ai.enabled }); }
      catch (e) { return json(res, 400, { code: "invalid_argument", message: e.message }); }
    }
    if (p === "/api/keys/test" && req.method === "POST") {
      const b = await readBody(req, 4096);
      try { return json(res, 200, await connectors.test(String(b.id || ""))); } catch (e) { return json(res, 200, { ok: false, message: e.message }); }
    }
    if (p === "/api/status") return json(res, 200, { ai: ai.enabled, connectors: connectors.status(), db: { docs: db.docs.size, dir: db.dir } });
    if (p === "/api/db" && req.method === "POST") {
      const b = await readBody(req);
      try { return json(res, 200, dbOp(b)); } catch (e) { return json(res, 400, { code: e.code || "invalid_argument", message: e.message }); }
    }
    if (p === "/api/db/events") {
      const send = sse(res);
      const off = db.onChange((paths, v) => send("change", { paths, v }));
      const hb = setInterval(() => res.write(": hb\n\n"), 25000);
      req.on("close", () => { off(); clearInterval(hb); }); return;
    }
    if (p === "/api/db/stats") return json(res, 200, db.stats());
    if (p === "/api/db/export") {
      res.writeHead(200, { "content-type": "application/json", "content-disposition": `attachment; filename="tapewire-memory-${new Date().toISOString().slice(0, 10)}.json"` });
      res.end(JSON.stringify(db.dump())); return;
    }
    if (p === "/api/db/import" && req.method === "POST") { const b = await readBody(req); return json(res, 200, { restored: db.restore(b.dump, { replace: !!b.replace }) }); }
    if (p === "/api/db/backup" && req.method === "POST") return json(res, 200, { file: db.backup(cfg.backupsKeep) });
    if (p === "/api/mcp/call" && req.method === "POST") {
      const b = await readBody(req);
      try { const r = await connectors.call(String(b.server || ""), String(b.tool || ""), b.input || {}); return json(res, 200, { payload: r.payload }); }
      catch (e) { const te = e instanceof ToolError ? e : new ToolError("tool_error", e.message); return json(res, 502, { code: te.code, message: te.message, retryable: !!te.retryable, retryAfterMs: te.retryAfterMs || 0 }); }
    }
    if (p === "/api/ai/turn" && req.method === "POST") {
      const b = await readBody(req);
      const send = sse(res); const ctl = new AbortController();
      res.on("close", () => { if (!res.writableFinished) ctl.abort(); });
      await ai.turn(b, send, ctl.signal); res.end(); return;
    }
    if (p.startsWith("/api/")) return json(res, 404, { code: "not_found", message: p });
    // static files
    const file = path.normalize(path.join(PUBLIC, p === "/" ? "index.html" : decodeURIComponent(p)));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { "content-type": "text/plain" }); res.end("Not found"); return; }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" }); res.end(buf);
    });
  } catch (e) {
    console.error(`[http] ${req.method} ${p}: ${e.stack || e.message}`);
    if (!res.headersSent) json(res, 500, { code: "internal", message: e.message }); else res.end();
  }
}

const server = http.createServer(handle);
server.requestTimeout = 0; // AI turns can stream for minutes
server.listen(cfg.port, cfg.host, () => {
  const where = `http://${cfg.host === "0.0.0.0" ? "localhost" : cfg.host}:${cfg.port}`;
  console.log(`\n  Tapewire is running at ${where}\n`);
  console.log(`  AI (Anthropic): ${ai.enabled ? `on, ${cfg.anthropic.models.default}` : "off - set ANTHROPIC_API_KEY in .env"}`);
  for (const [k, v] of Object.entries(connectors.status())) console.log(`  ${k.padEnd(26)} ${v}`);
  console.log(`  Library: ${db.dir}\n`);
  backupIfDue(); setInterval(backupIfDue, 3 * 3600 * 1000);
});
const stop = () => { console.log("\n[db] saving…"); db.flushAll(); process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
