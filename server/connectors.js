// Stand-in for the claude.ai `mcp` capability. The page calls connectors by their claude.ai display name
// ("Crypto.com", "Twelve Data", ...). Each call is answered, in order of preference, by:
//   1. a remote MCP server configured in tapewire.config.json  (exact upstream behaviour), or
//   2. a built-in adapter that talks to the public REST API and returns the same shapes, or
//   3. a `server_not_connected` error the page already knows how to show.
// Free data (RSS, public JSON, Crypto.com, Google News search) needs no key at all.

export class ToolError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const MAX_BYTES = 6 * 1024 * 1024;

async function fetchText(url, { timeout = 20000, headers = {}, method = "GET", body } = {}) {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { method, body, redirect: "follow", signal: ctl.signal, headers: { "user-agent": UA, accept: "*/*", "accept-language": "en-US,en;q=0.9", ...headers } });
    const buf = Buffer.from(await r.arrayBuffer());
    return { ok: r.ok, status: r.status, url: r.url || url, text: buf.subarray(0, MAX_BYTES).toString("utf8") };
  } catch (e) {
    return { ok: false, status: 0, url, text: "", error: e.name === "AbortError" ? "timeout" : e.message };
  } finally { clearTimeout(timer); }
}
async function fetchJson(url, opts) {
  const r = await fetchText(url, opts);
  if (!r.ok && !r.text) throw new ToolError("server_unavailable", `${new URL(url).hostname} did not respond (${r.error || r.status})`, { retryable: true });
  try { return { status: r.status, json: JSON.parse(r.text) }; } catch (e) { throw new ToolError("tool_error", `${new URL(url).hostname} returned non-JSON (HTTP ${r.status})`); }
}

/* ---------- small HTML helpers ---------- */
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…" };
const decode = (s) => String(s || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => (e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m));
export function htmlToText(html) {
  let h = String(html || "");
  const art = /<article\b[\s\S]*?<\/article>/i.exec(h); if (art && art[0].length > 1500) h = art[0];
  h = h.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|button|figure)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|blockquote)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<h([1-6])[^>]*>/gi, (m, n) => "\n" + "#".repeat(+n) + " ")
    .replace(/<li[^>]*>/gi, "\n- ").replace(/<[^>]+>/g, " ");
  return decode(h).split("\n").map((l) => l.replace(/[ \t\f\v]+/g, " ").trim()).filter(Boolean).join("\n");
}
const stripTags = (s) => decode(String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/* Google News RSS search: the free stand-in for news-search tools */
async function newsSearch(query, minutes = 1440, limit = 15) {
  const when = minutes <= 60 ? "1h" : minutes <= 24 * 60 ? `${Math.ceil(minutes / 60)}h` : `${Math.ceil(minutes / 1440)}d`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:${when}`)}&hl=en-US&gl=US&ceid=US:en`;
  const r = await fetchText(url, { timeout: 15000 });
  if (!r.ok) throw new ToolError("server_unavailable", `news search failed (${r.error || r.status})`, { retryable: true });
  const out = []; const re = /<item>([\s\S]*?)<\/item>/g; let m;
  while ((m = re.exec(r.text)) && out.length < limit) {
    const tag = (n) => (new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`).exec(m[1]) || [])[1] || "";
    const publisher = stripTags(tag("source")); let title = stripTags(tag("title"));
    if (publisher && title.endsWith(" - " + publisher)) title = title.slice(0, -(publisher.length + 3));
    const d = Date.parse(stripTags(tag("pubDate")));
    out.push({ title, url: stripTags(tag("link")), snippet: "", publisher, date: Number.isFinite(d) ? new Date(d).toISOString() : null });
  }
  return out;
}

/* ---------- Crypto.com exchange (public, free) ---------- */
const CDC = "https://api.crypto.com/exchange/v1/public/";
const cdcTicker = (x) => ({ instrument_name: x.i, last: x.a, change: x.c, high: x.h, low: x.l, volume: x.v, volume_value: x.vv, best_bid: x.b, best_ask: x.k, open_interest: x.oi ?? "0", timestamp: x.t ? new Date(+x.t).toISOString() : null });
async function cdc(method, params) {
  const q = new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v != null && v !== "")).toString();
  const { json } = await fetchJson(CDC + method + (q ? "?" + q : ""), { timeout: 15000 });
  if (json.code && json.code !== 0) throw new ToolError("tool_error", `Crypto.com: ${json.message || json.code}`);
  return json.result || {};
}
const cryptoCom = {
  async get_ticker({ instrument_name }) { const r = await cdc("get-tickers", { instrument_name }); const x = (r.data || [])[0]; if (!x) throw new ToolError("tool_error", `Crypto.com has no ticker for ${instrument_name}`); return cdcTicker(x); },
  async get_tickers({ instrument_name } = {}) { const r = await cdc("get-tickers", { instrument_name }); return { data: (r.data || []).map(cdcTicker) }; },
  async get_candlestick({ instrument_name, timeframe = "1h", count = 100 }) {
    const r = await cdc("get-candlestick", { instrument_name, timeframe, count });
    return { instrument_name, timeframe, data: (r.data || []).map((b) => ({ open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, volume_usd: String((+b.v || 0) * (+b.c || 0)), timestamp: new Date(+b.t).toISOString() })).reverse() };
  },
  async get_instruments() { const r = await cdc("get-instruments", {}); return { data: (r.data || []).map((x) => ({ ...x, instrument_name: x.symbol })) }; },
  async get_book({ instrument_name, depth = 50 }) { return cdc("get-book", { instrument_name, depth }); },
  async get_trades({ instrument_name, count = 100 }) { return cdc("get-trades", { instrument_name, count }); }
};

/* ---------- Twelve Data (key) ---------- */
// The Twelve Data connector answers with semicolon-separated text: header line, then rows. Mirror that.
function flatten(o, pre = "", out = {}) { for (const [k, v] of Object.entries(o || {})) { if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, `${pre}${k}_`, out); else out[pre + k] = v; } return out; }
const semi = (rows) => { if (!rows.length) return ""; const head = Object.keys(rows[0]); return [head.join(";"), ...rows.map((r) => head.map((h) => (r[h] == null ? "" : String(r[h]).replace(/[;\n]/g, " "))).join(";"))].join("\n") + "\n"; };
function twelveData(cfg) {
  const call = async (ep, params) => {
    if (!cfg.keys.twelvedata) throw new ToolError("server_not_connected", "Twelve Data has no API key. Add TWELVEDATA_API_KEY to .env (free key at twelvedata.com).");
    const q = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== "")), apikey: cfg.keys.twelvedata });
    const { json } = await fetchJson(`https://api.twelvedata.com/${ep}?${q}`);
    if (json.status === "error" || (json.code && json.code >= 400)) return { result: /run out of API credits|exclusively|upgrad/i.test(json.message || "") ? json.message : `Error: ${json.message || json.code}` };
    return { json };
  };
  return {
    async get_quote({ symbol, prepost }) { const r = await call("quote", { symbol, prepost }); return r.json ? { result: semi([flatten(r.json)]) } : r; },
    async get_time_series({ symbol, interval = "1day", outputsize = 30, start_date, end_date, prepost }) {
      const r = await call("time_series", { symbol, interval, outputsize, start_date, end_date, prepost }); if (!r.json) return r;
      return { result: semi((r.json.values || []).map((v) => ({ datetime: v.datetime, open: v.open, high: v.high, low: v.low, close: v.close, volume: v.volume ?? "" }))) };
    },
    async get_analyst_data({ symbol, data_type = "ratings" }) {
      const ep = { ratings: "analyst_ratings/us_equities", price_target: "price_target", recommendations: "recommendations", eps_trend: "eps_trend", eps_revisions: "eps_revisions", earnings_estimate: "earnings_estimate", revenue_estimate: "revenue_estimate", growth_estimates: "growth_estimates" }[data_type] || "analyst_ratings/us_equities";
      const r = await call(ep, { symbol }); return r.json ? { result: JSON.stringify(r.json) } : r;
    }
  };
}

/* ---------- Alpha Vantage (key) ---------- */
function alphaVantage(cfg) {
  const q = async (fn, args) => {
    if (!cfg.keys.alphavantage) throw new ToolError("server_not_connected", "Alpha Vantage has no API key. Add ALPHAVANTAGE_API_KEY to .env (free key at alphavantage.co).");
    const p = new URLSearchParams({ function: fn, ...Object.fromEntries(Object.entries(args || {}).filter(([, v]) => v != null && v !== "")), apikey: cfg.keys.alphavantage });
    return (await fetchJson(`https://www.alphavantage.co/query?${p}`)).json;
  };
  return new Proxy({}, { get: (_, tool) => (typeof tool === "string" && /^[A-Z_0-9]+$/.test(tool) ? (args) => q(tool, args) : undefined) });
}

/* ---------- Firecrawl: scrape is a direct fetch (free); search uses Firecrawl's API with a key, else Google News ---------- */
function firecrawl(cfg) {
  const api = async (ep, body) => {
    const r = await fetchText(`https://api.firecrawl.dev/v2/${ep}`, { method: "POST", timeout: 60000, headers: { "content-type": "application/json", authorization: `Bearer ${cfg.keys.firecrawl}` }, body: JSON.stringify(body) });
    let j; try { j = JSON.parse(r.text); } catch (e) { throw new ToolError("tool_error", `Firecrawl returned HTTP ${r.status}`); }
    if (r.status === 429) throw new ToolError("tool_error", "Firecrawl rate limit. Retry after 30s", { retryable: true });
    if (r.status === 402) throw new ToolError("tool_error", "Firecrawl: payment required, out of credits");
    if (!j.success) throw new ToolError("tool_error", `Firecrawl: ${j.error || r.status}`);
    return j.data;
  };
  return {
    async firecrawl_scrape({ url, formats = ["markdown"] }) {
      const r = await fetchText(url, { timeout: 30000 });
      const blocked = !r.ok || (/<title>[^<]*(access denied|just a moment|attention required)/i.test(r.text));
      if (blocked && cfg.keys.firecrawl) return api("scrape", { url, formats, onlyMainContent: true });
      if (!r.ok && !r.text) throw new ToolError("tool_error", `Could not fetch ${url}: ${r.error || "HTTP " + r.status}`);
      const out = { metadata: { sourceURL: url, url: r.url, statusCode: r.status } };
      if (formats.includes("rawHtml") || formats.includes("html")) { out.rawHtml = r.text; out.html = r.text; }
      if (formats.includes("markdown")) out.markdown = /^\s*[{[]/.test(r.text) ? r.text : htmlToText(r.text);
      return out;
    },
    async firecrawl_search({ query, limit = 10, tbs }) {
      if (cfg.keys.firecrawl) return { data: await api("search", { query, limit, sources: ["news"], tbs }) };
      const mins = /qdr:h/.test(tbs || "") ? 60 : /qdr:w/.test(tbs || "") ? 7 * 1440 : 1440;
      const items = await newsSearch(query, mins, limit);
      return { data: { news: items.map((x) => ({ title: x.title, url: x.url, snippet: x.publisher, date: x.date })) } };
    }
  };
}

/* ---------- TinyFish: batch fetch + news search, done directly ---------- */
const tinyfish = {
  async fetch_content({ urls = [], format = "html", per_url_timeout_ms = 25000 }) {
    const res = await Promise.all(urls.slice(0, 20).map(async (u) => {
      const r = await fetchText(u, { timeout: Math.min(per_url_timeout_ms, 45000) });
      if (!r.ok) return { err: { url: u, error: r.error || `HTTP ${r.status}`, status: r.status } };
      return { ok: { url: u, final_url: r.url, text: format === "markdown" && /<(html|body|p|div)[\s>]/i.test(r.text) ? htmlToText(r.text) : r.text } };
    }));
    return { results: res.filter((x) => x.ok).map((x) => x.ok), errors: res.filter((x) => x.err).map((x) => x.err) };
  },
  async search({ query, recency_minutes = 1440 }) { return { results: await newsSearch(query, recency_minutes, 15) }; },
  async get_wallet() { return { available_balance: null, currency: "USD", note: "Direct fetching is free in the standalone app" }; }
};

/* ---------- Tavily (key) ---------- */
function tavily(cfg) {
  return {
    async tavily_search(args) {
      if (!cfg.keys.tavily) throw new ToolError("server_not_connected", "Tavily has no API key. Add TAVILY_API_KEY to .env.");
      const r = await fetchText("https://api.tavily.com/search", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cfg.keys.tavily}` }, body: JSON.stringify(args) });
      if (!r.ok) throw new ToolError("tool_error", `Tavily HTTP ${r.status}`); return JSON.parse(r.text);
    }
  };
}

/* ---------- remote MCP (Streamable HTTP) for connectors without a built-in adapter ---------- */
class RemoteMcp {
  constructor(name, spec) { this.name = name; this.url = spec.url; this.headers = spec.headers || {}; this.session = null; this.id = 0; }
  async rpc(method, params, notify = false) {
    const body = JSON.stringify(notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++this.id, method, params });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", ...this.headers };
    if (this.session) headers["mcp-session-id"] = this.session;
    const r = await fetch(this.url, { method: "POST", headers, body, signal: AbortSignal.timeout(120000) });
    const sid = r.headers.get("mcp-session-id"); if (sid) this.session = sid;
    if (r.status === 401 || r.status === 403) throw new ToolError("needs_reauth", `${this.name} rejected the credentials in tapewire.config.json (HTTP ${r.status}).`);
    if (r.status === 404 && this.session) { this.session = null; throw new ToolError("server_unavailable", `${this.name} session expired`, { retryable: true }); }
    if (notify) return null;
    const text = await r.text();
    let msg = null;
    if ((r.headers.get("content-type") || "").includes("text/event-stream")) {
      for (const block of text.split(/\n\n/)) { const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join(""); if (!data) continue; try { const j = JSON.parse(data); if (j.id === this.id) msg = j; } catch (e) { /* keep-alive */ } }
    } else { try { msg = JSON.parse(text); } catch (e) { /* fallthrough */ } }
    if (!msg) throw new ToolError("server_unavailable", `${this.name} sent an unreadable reply (HTTP ${r.status})`, { retryable: true });
    if (msg.error) throw new ToolError("tool_error", `${this.name}: ${msg.error.message || JSON.stringify(msg.error)}`);
    return msg.result;
  }
  async ensure() {
    if (this.session || this.ready) return;
    await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tapewire", version: "1.0" } });
    await this.rpc("notifications/initialized", {}, true).catch(() => {});
    this.ready = true;
  }
  async call(tool, args) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.ensure();
        const res = await this.rpc("tools/call", { name: tool, arguments: args || {} });
        const text = (res?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
        if (res?.isError) throw new ToolError("tool_error", text.slice(0, 600) || "tool reported an error");
        return { payload: res?.structuredContent ?? text, content: res?.content || [] };
      } catch (e) {
        if (e.code === "server_unavailable" && attempt === 0) { this.session = null; this.ready = false; continue; }
        if (e instanceof ToolError) throw e;
        throw new ToolError("server_unavailable", `${this.name}: ${e.message}`, { retryable: true });
      }
    }
  }
}

export function makeConnectors(cfg) {
  const builtin = {
    "Crypto.com": cryptoCom,
    "Twelve Data": twelveData(cfg),
    "Alpha Vantage MCP Server": alphaVantage(cfg),
    "Firecrawl": firecrawl(cfg),
    "TinyFish": tinyfish,
    "Tavily": tavily(cfg)
  };
  const remote = new Map(Object.entries(cfg.mcp || {}).filter(([, s]) => s && s.url && s.enabled !== false).map(([k, s]) => [k, new RemoteMcp(k, s)]));
  const status = () => {
    const out = {};
    for (const n of new Set([...Object.keys(builtin), ...remote.keys(), "CoinMarketCap", "Bigdata.com"])) {
      out[n] = remote.has(n) ? "remote MCP" : n === "Twelve Data" ? (cfg.keys.twelvedata ? "API key" : "needs key") : n === "Alpha Vantage MCP Server" ? (cfg.keys.alphavantage ? "API key" : "needs key") : n === "Tavily" ? (cfg.keys.tavily ? "API key" : "needs key") : builtin[n] ? (n === "Firecrawl" && cfg.keys.firecrawl ? "direct + API key" : "direct (free)") : "not configured";
    }
    return out;
  };
  async function call(server, tool, input) {
    if (remote.has(server)) return remote.get(server).call(tool, input);
    const h = builtin[server];
    if (!h) throw new ToolError("server_not_connected", `${server} isn't set up. Add it under "mcp" in tapewire.config.json to use it.`);
    const fn = h[tool];
    if (typeof fn !== "function") throw new ToolError("tool_error", `${server} has no built-in "${tool}" tool. Configure the remote MCP server for it in tapewire.config.json.`);
    const payload = await fn.call(h, input || {});
    return { payload, content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }] };
  }
  return { call, status };
}
