// Keyed news and price APIs. Every provider's output is normalised to
//   { t: epoch ms, title, url, sum, outlet, tk: [tickers], sent: -1..1 | null }
// so the page ingests them exactly like its RSS feeds and the news model can learn which provider matters.
const UA = "Tapewire/1.0 (+local)";

export class ProviderError extends Error { constructor(code, message) { super(message); this.code = code; } }

async function getJson(url, { headers = {}, timeout = 20000 } = {}) {
  let r;
  try { r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeout) }); }
  catch (e) { throw new ProviderError("server_unavailable", `${new URL(url).hostname} did not respond (${e.name === "TimeoutError" ? "timeout" : e.message})`); }
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) { /* not json */ }
  if (r.status === 401 || r.status === 403) throw new ProviderError("needs_reauth", `${new URL(url).hostname} rejected the key (HTTP ${r.status})${j?.message ? ": " + j.message : ""}`);
  if (r.status === 429) throw new ProviderError("tool_error", `${new URL(url).hostname} rate limit reached (429). Retry after 60s`);
  if (!r.ok) throw new ProviderError("tool_error", `${new URL(url).hostname} HTTP ${r.status}${j?.message || j?.error ? ": " + (j.message || j.error) : ""}`);
  if (j == null) throw new ProviderError("tool_error", `${new URL(url).hostname} sent non-JSON`);
  return j;
}
const ts = (v) => { if (v == null) return null; if (typeof v === "number") return v < 2e10 ? v * 1000 : v; const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
const clip = (s, n = 400) => String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const dayStr = (t) => new Date(t).toISOString().slice(0, 10);
const syms = (a) => [...new Set((a || []).map((x) => String(x).toUpperCase()).filter((x) => /^[A-Z][A-Z.\-]{0,6}$/.test(x)))].slice(0, 25);

/* ---- news providers: id -> { keys: [key ids], label, fetch(cfg, {symbols, limit}) } ---- */
export const NEWS_PROVIDERS = {
  alpaca: {
    label: "Benzinga via Alpaca", keys: ["alpaca_id", "alpaca_secret"],
    async fetch(k, { limit = 50 }) {
      const j = await getJson(`https://data.alpaca.markets/v1beta1/news?limit=${Math.min(50, limit)}&sort=desc&include_content=false`, { headers: { "APCA-API-KEY-ID": k.alpaca_id, "APCA-API-SECRET-KEY": k.alpaca_secret } });
      return (j.news || []).map((n) => ({ t: ts(n.created_at), title: n.headline, url: n.url, sum: clip(n.summary), outlet: n.source ? `${n.source}` : "Benzinga", tk: syms(n.symbols), sent: null }));
    }
  },
  finnhub: {
    label: "Finnhub", keys: ["finnhub"],
    async fetch(k, { symbols = [] }) {
      const out = [];
      const gen = await getJson(`https://finnhub.io/api/v1/news?category=general&token=${k.finnhub}`);
      for (const n of gen || []) out.push({ t: ts(n.datetime), title: n.headline, url: n.url, sum: clip(n.summary), outlet: n.source || "Finnhub", tk: syms(String(n.related || "").split(",")), sent: null });
      // one company per call, rotating through the watchlist (free tier: 60 calls a minute)
      const s = syms(symbols); if (s.length) {
        const T = s[Math.floor(Date.now() / 180000) % s.length];
        const co = await getJson(`https://finnhub.io/api/v1/company-news?symbol=${T}&from=${dayStr(Date.now() - 2 * 864e5)}&to=${dayStr(Date.now())}&token=${k.finnhub}`).catch(() => []);
        for (const n of (co || []).slice(0, 30)) out.push({ t: ts(n.datetime), title: n.headline, url: n.url, sum: clip(n.summary), outlet: n.source || "Finnhub", tk: syms([T, ...String(n.related || "").split(",")]), sent: null });
      }
      return out;
    }
  },
  polygon: {
    label: "Polygon.io", keys: ["polygon"],
    async fetch(k, { limit = 50 }) {
      const j = await getJson(`https://api.polygon.io/v2/reference/news?limit=${Math.min(100, limit)}&order=desc&sort=published_utc&apiKey=${k.polygon}`);
      return (j.results || []).map((n) => {
        const ins = n.insights || []; const sc = { positive: 0.5, negative: -0.5, neutral: 0 };
        const sent = ins.length ? ins.reduce((a, x) => a + (sc[x.sentiment] ?? 0), 0) / ins.length : null;
        return { t: ts(n.published_utc), title: n.title, url: n.article_url, sum: clip(n.description), outlet: n.publisher?.name || "Polygon", tk: syms(n.tickers), sent };
      });
    }
  },
  benzinga: {
    label: "Benzinga", keys: ["benzinga"],
    async fetch(k, { limit = 50 }) {
      const j = await getJson(`https://api.benzinga.com/api/v2/news?token=${k.benzinga}&pageSize=${Math.min(100, limit)}&displayOutput=abstract&sort=created:desc`);
      return (Array.isArray(j) ? j : []).map((n) => ({ t: ts(n.created), title: n.title, url: n.url, sum: clip(n.teaser), outlet: "Benzinga", tk: syms((n.stocks || []).map((s) => s.name)), sent: null }));
    }
  },
  fmp: {
    label: "Financial Modeling Prep", keys: ["fmp"],
    async fetch(k, { limit = 50 }) {
      const [stock, gen] = await Promise.all([
        getJson(`https://financialmodelingprep.com/stable/news/stock-latest?page=0&limit=${Math.min(100, limit)}&apikey=${k.fmp}`).catch(() => []),
        getJson(`https://financialmodelingprep.com/stable/news/general-latest?page=0&limit=30&apikey=${k.fmp}`).catch(() => [])
      ]);
      return [...(stock || []), ...(gen || [])].map((n) => ({ t: ts(n.publishedDate ? n.publishedDate.replace(" ", "T") + (/[zZ+]/.test(n.publishedDate) ? "" : "-04:00") : null), title: n.title, url: n.url, sum: clip(n.text), outlet: n.publisher || n.site || "FMP", tk: syms(n.symbol ? [n.symbol] : []), sent: null }));
    }
  },
  marketaux: {
    label: "Marketaux", keys: ["marketaux"],
    async fetch(k) {
      const j = await getJson(`https://api.marketaux.com/v1/news/all?countries=us&filter_entities=true&must_have_entities=true&language=en&limit=3&api_token=${k.marketaux}`);
      return (j.data || []).map((n) => { const ents = (n.entities || []).filter((e) => e.symbol); const s = ents.map((e) => e.sentiment_score).filter(Number.isFinite); return { t: ts(n.published_at), title: n.title, url: n.url, sum: clip(n.description || n.snippet), outlet: n.source || "Marketaux", tk: syms(ents.map((e) => e.symbol)), sent: s.length ? s.reduce((a, b) => a + b, 0) / s.length : null }; });
    }
  },
  newsapi: {
    label: "NewsAPI", keys: ["newsapi"],
    async fetch(k) {
      const j = await getJson(`https://newsapi.org/v2/top-headlines?category=business&country=us&pageSize=50&apiKey=${k.newsapi}`);
      return (j.articles || []).map((n) => { let title = n.title || ""; const src = n.source?.name || "NewsAPI"; if (title.endsWith(" - " + src)) title = title.slice(0, -(src.length + 3)); return { t: ts(n.publishedAt), title, url: n.url, sum: clip(n.description), outlet: src, tk: [], sent: null }; });
    }
  },
  tiingo: {
    label: "Tiingo", keys: ["tiingo"],
    async fetch(k, { limit = 50 }) {
      const j = await getJson(`https://api.tiingo.com/tiingo/news?limit=${Math.min(100, limit)}&token=${k.tiingo}`);
      return (Array.isArray(j) ? j : []).map((n) => ({ t: ts(n.publishedDate), title: n.title, url: n.url, sum: clip(n.description), outlet: n.source || "Tiingo", tk: syms(n.tickers), sent: null }));
    }
  }
};
export const configuredNews = (keys) => Object.entries(NEWS_PROVIDERS).filter(([, p]) => p.keys.every((k) => keys[k])).map(([id]) => id);

export function newsConnector(cfg) {
  return {
    async providers() { return { providers: configuredNews(cfg.keys).map((id) => ({ id, label: NEWS_PROVIDERS[id].label })) }; },
    async latest({ provider, symbols = [], limit = 50 }) {
      const p = NEWS_PROVIDERS[provider]; if (!p) throw new ProviderError("tool_error", `unknown news provider ${provider}`);
      if (!p.keys.every((k) => cfg.keys[k])) throw new ProviderError("server_not_connected", `${p.label} has no API key. Add it under Sources & keys → API keys.`);
      const items = (await p.fetch(cfg.keys, { symbols, limit })).filter((x) => x.title && x.t);
      return { provider, items };
    }
  };
}

/* ---- price fallbacks used by the Twelve Data adapter when it has no key ---- */
const ETF = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const etStr = (ms) => { const o = {}; for (const x of ETF.formatToParts(new Date(ms))) o[x.type] = x.value; return `${o.year}-${o.month}-${o.day} ${String(+o.hour % 24).padStart(2, "0")}:${o.minute}:${o.second}`; };
function usOpenNow() { const s = etStr(Date.now()); const d = new Date(Date.now()).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short" }); const m = +s.slice(11, 13) * 60 + +s.slice(14, 16); return !["Sat", "Sun"].includes(d) && m >= 570 && m < 960; }
export const priceFallback = {
  available: (keys) => !!(keys.finnhub || keys.fmp || keys.polygon),
  async quote(keys, symbol) {
    if (keys.finnhub) { const q = await getJson(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${keys.finnhub}`); if (q && q.c) return { symbol, close: q.c, previous_close: q.pc, percent_change: q.dp, high: q.h, low: q.l, open: q.o, timestamp: q.t, last_quote_at: q.t, is_market_open: String(usOpenNow()) }; }
    if (keys.fmp) { const a = await getJson(`https://financialmodelingprep.com/stable/quote?symbol=${encodeURIComponent(symbol)}&apikey=${keys.fmp}`); const q = Array.isArray(a) ? a[0] : null; if (q?.price) return { symbol, close: q.price, previous_close: q.previousClose, percent_change: q.changePercentage, high: q.dayHigh, low: q.dayLow, open: q.open, timestamp: q.timestamp, last_quote_at: q.timestamp, is_market_open: String(usOpenNow()) }; }
    if (keys.polygon) { const j = await getJson(`https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(symbol)}/prev?apiKey=${keys.polygon}`); const q = j.results?.[0]; if (q) return { symbol, close: q.c, previous_close: "", percent_change: "", high: q.h, low: q.l, open: q.o, timestamp: Math.round(q.t / 1000), last_quote_at: Math.round(q.t / 1000), is_market_open: "false" }; }
    throw new ProviderError("tool_error", `no fallback quote for ${symbol}`);
  },
  async series(keys, symbol, interval, outputsize) {
    const m = /^(\d+)(min|h)$/.exec(interval || ""); const mult = m ? (m[2] === "h" ? 60 : 1) * +m[1] : null;
    if (keys.polygon && mult) {
      const to = Date.now(), from = to - Math.max(2, Math.ceil((outputsize * mult) / 390) + 3) * 864e5;
      const j = await getJson(`https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${mult}/minute/${from}/${to}?adjusted=true&sort=desc&limit=${Math.min(5000, outputsize * 3)}&apiKey=${keys.polygon}`);
      const rows = (j.results || []).map((b) => ({ datetime: etStr(b.t), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v })).filter((r) => { const mm = +r.datetime.slice(11, 13) * 60 + +r.datetime.slice(14, 16); return mm >= 570 && mm < 960; });
      if (rows.length) return rows.slice(0, outputsize);
    }
    if (keys.fmp && mult && [1, 5, 15, 30, 60].includes(mult)) {
      const a = await getJson(`https://financialmodelingprep.com/stable/historical-chart/${mult === 60 ? "1hour" : mult + "min"}?symbol=${encodeURIComponent(symbol)}&apikey=${keys.fmp}`);
      if (Array.isArray(a) && a.length) return a.slice(0, outputsize).map((b) => ({ datetime: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
    }
    throw new ProviderError("tool_error", `no fallback ${interval} bars for ${symbol}`);
  }
};
