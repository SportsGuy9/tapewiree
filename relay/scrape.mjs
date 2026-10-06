// Tapewire relay: fetches the news feeds and market-data endpoints the Tapewire page uses, trims them,
// and writes compact JSON bundles the page can read in a few requests instead of one request per feed.
// No dependencies (Node 20+). Usage: node relay/scrape.mjs <outDir>
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] || join(here, "..", "relay-out");
const sources = JSON.parse(await readFile(join(here, "sources.json"), "utf8"));
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 TapewireRelay/1";
const MAX_BODY = 260_000;   // a single source larger than this after trimming is left to the page's own fetchers
const MAX_GROUP = 900_000;  // keep each bundle file small enough to read in one request
const ITEMS = 30;

const dynUrl = (d) => {
  const [kind, ccy] = d.split(":"); const e = Date.now();
  if (kind === "dvol") return `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${ccy}&resolution=3600&start_timestamp=${e - 50 * 3600e3}&end_timestamp=${e}`;
  throw new Error("unknown dyn " + d);
};

/* keep the feed's own format (the page's parsers read RSS, Atom and the SEC/Nasdaq variants as-is), but drop what they never read */
const plainText = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;[\s\S]*?&gt;/g, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const esc = (s) => s.replace(/&(?!(?:[a-z]+|#\d+|#x[0-9a-f]+);)/gi, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function trimFeed(xml) {
  let x = xml.replace(/<content:encoded>[\s\S]*?<\/content:encoded>/gi, "").replace(/<media:[^>]*\/>/gi, "").replace(/<media:(\w+)[^>]*>[\s\S]*?<\/media:\1>/gi, "");
  x = x.replace(/<(description|summary|content)(\b[^>]*)>([\s\S]*?)<\/\1>/gi, (m, tag, attrs, inner) => {
    if (inner.length <= 600) return m; const t = plainText(inner).slice(0, 400);
    return `<${tag}${attrs.replace(/\stype="[^"]*"/, "")}>${esc(t)}</${tag}>`;
  });
  let n = 0;
  x = x.replace(/<(item|entry)\b[^>]*>[\s\S]*?<\/\1>/gi, (m) => (++n <= ITEMS ? m : ""));
  return x.replace(/>\s+</g, "><").replace(/[ \t]{2,}/g, " ");
}
function trimJson(text) { return JSON.stringify(JSON.parse(text)); }

async function fetchOne(src) {
  const url = src.url || dynUrl(src.dyn); const t0 = Date.now();
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: "follow", headers: { "user-agent": UA, accept: src.kind === "json" ? "application/json,*/*;q=0.8" : "application/rss+xml,application/atom+xml,application/xml,text/xml,text/html;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.9" } });
    const text = await r.text(); const ms = Date.now() - t0;
    if (!r.ok) return { id: src.id, url, s: r.status, ms, e: `http ${r.status}` };
    let b = text;
    if (src.kind === "json") b = trimJson(text);
    else if (src.kind === "rss") b = trimFeed(text);
    else b = text.replace(/\s{2,}/g, " ");
    if (b.length > MAX_BODY) return { id: src.id, url, s: r.status, ms, e: `too big (${b.length} bytes)`, n: b.length };
    return { id: src.id, url, s: r.status, ms, b };
  } catch (e) {
    return { id: src.id, url, s: 0, ms: Date.now() - t0, e: e.name === "AbortError" ? "timeout" : String(e.message || e).slice(0, 120) };
  } finally { clearTimeout(timer); }
}

async function pool(list, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k]); } })); return out; }

const started = Date.now();
const results = await pool(sources, 8, fetchOne);
const at = Date.now();
await mkdir(outDir, { recursive: true });
const groups = {};
for (const r of results) {
  const src = sources.find((s) => s.id === r.id); const g = src.group;
  const G = (groups[g] ||= { v: 1, t: at, items: {}, size: 0 });
  if (r.b == null) continue;
  if (G.size + r.b.length > MAX_GROUP) { r.e = "group full"; delete r.b; continue; }
  G.items[src.url ? r.url : src.dyn] = { t: at, s: r.s, b: r.b }; G.size += r.b.length;
}
/* "<" and "&" are written as \u escapes so the file survives fetchers that wrap text in HTML */
const safe = (o) => JSON.stringify(o).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
for (const [g, G] of Object.entries(groups)) { delete G.size; await writeFile(join(outDir, `${g}.json`), safe(G)); }
const status = { v: 1, t: at, took: at - started, ok: results.filter((r) => r.b != null).length, total: results.length,
  groups: Object.fromEntries(Object.entries(groups).map(([g, G]) => [g, Object.keys(G.items).length])),
  sources: results.map((r) => ({ id: r.id, s: r.s, ms: r.ms, e: r.e || undefined, n: r.b ? r.b.length : undefined })) };
await writeFile(join(outDir, "status.json"), JSON.stringify(status, null, 1));
console.log(`relay: ${status.ok}/${status.total} sources in ${status.took} ms`);
for (const r of results) if (r.e) console.log(`  ${r.id}: ${r.e}`);
