// Offline test of the keyed news providers and price fallbacks with mocked HTTP responses: `node server/newstest.js`
import assert from "node:assert/strict";
import { NEWS_PROVIDERS, newsConnector, priceFallback, configuredNews } from "./news.js";
import { makeConnectors } from "./connectors.js";
const now = Date.now(); const iso = new Date(now - 6e5).toISOString();
const FIX = [
  [/alpaca\.markets/, { news: [{ headline: "Nvidia beats estimates", created_at: iso, url: "https://b/1", summary: "<p>NVDA</p>", source: "benzinga", symbols: ["NVDA"] }] }],
  [/finnhub\.io\/api\/v1\/news/, [{ datetime: Math.floor(now / 1000) - 600, headline: "Stocks rise", url: "https://f/1", summary: "s", source: "Reuters", related: "AAPL,MSFT" }]],
  [/finnhub\.io\/api\/v1\/company-news/, [{ datetime: Math.floor(now / 1000) - 900, headline: "Apple supplier news", url: "https://f/2", summary: "", source: "Yahoo", related: "AAPL" }]],
  [/finnhub\.io\/api\/v1\/quote/, { c: 101.5, pc: 100, dp: 1.5, h: 102, l: 99, o: 100, t: Math.floor(now / 1000) }],
  [/polygon\.io\/v2\/reference\/news/, { results: [{ title: "Tesla recalls cars", published_utc: iso, article_url: "https://p/1", description: "d", publisher: { name: "Zacks" }, tickers: ["TSLA"], insights: [{ ticker: "TSLA", sentiment: "negative" }] }] }],
  [/polygon\.io\/v2\/aggs\/ticker\/QQQ\/range/, { results: [{ t: Date.parse("2026-10-02T19:55:00Z"), o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }, { t: Date.parse("2026-10-02T22:00:00Z"), o: 1, h: 1, l: 1, c: 1, v: 1 }] }],
  [/benzinga\.com/, [{ title: "Fed speaker", created: new Date(now - 6e5).toUTCString(), url: "https://bz/1", teaser: "t", stocks: [{ name: "SPY" }] }]],
  [/financialmodelingprep\.com\/stable\/news\/stock/, [{ symbol: "AMD", publishedDate: "2026-10-03 09:30:00", publisher: "Motley", title: "AMD rallies", text: "x", url: "https://m/1" }]],
  [/financialmodelingprep\.com\/stable\/news\/general/, [{ publishedDate: "2026-10-03 09:31:00", publisher: "CNBC", title: "Markets open", text: "x", url: "https://m/2" }]],
  [/marketaux\.com/, { data: [{ title: "Micron guidance", url: "https://mx/1", published_at: iso, source: "x.com", description: "d", entities: [{ symbol: "MU", sentiment_score: 0.6 }] }] }],
  [/newsapi\.org/, { articles: [{ title: "Oil jumps - Reuters", source: { name: "Reuters" }, url: "https://n/1", publishedAt: iso, description: "d" }] }],
  [/tiingo\.com/, [{ title: "Broadcom deal", url: "https://t/1", publishedDate: iso, source: "bloomberg.com", tickers: ["avgo"], description: "d" }]]
];
globalThis.fetch = async (url) => { const hit = FIX.find(([re]) => re.test(String(url))); const body = hit ? JSON.stringify(hit[1]) : "{}"; return { ok: !!hit, status: hit ? 200 : 404, url: String(url), text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer, headers: { get: () => null } }; };
const keys = { alpaca_id: "a", alpaca_secret: "b", finnhub: "f", polygon: "p", benzinga: "z", fmp: "m", marketaux: "x", newsapi: "n", tiingo: "t" };
assert.deepEqual(configuredNews(keys).sort(), Object.keys(NEWS_PROVIDERS).sort());
assert.deepEqual(configuredNews({ alpaca_id: "a" }), [], "Alpaca needs both halves");
const nc = newsConnector({ keys });
for (const id of Object.keys(NEWS_PROVIDERS)) {
  const r = await nc.latest({ provider: id, symbols: ["AAPL"] });
  assert.ok(r.items.length >= 1, id);
  for (const x of r.items) { assert.ok(x.title && Number.isFinite(x.t) && x.url && x.outlet && Array.isArray(x.tk), `${id} shape`); assert.ok(Math.abs(Date.now() - x.t) < 3 * 864e5, `${id} time ${x.t}`); }
}
assert.equal((await nc.latest({ provider: "polygon" })).items[0].sent, -0.5);
assert.deepEqual((await nc.latest({ provider: "tiingo" })).items[0].tk, ["AVGO"]);
assert.equal((await nc.latest({ provider: "newsapi" })).items[0].title, "Oil jumps");
await assert.rejects(newsConnector({ keys: {} }).latest({ provider: "finnhub" }), /no API key/);
// Twelve Data falls back to Finnhub quotes and Polygon bars, in Twelve Data's own text format
const C = makeConnectors({ keys: { finnhub: "f", polygon: "p" }, mcp: {}, mcpUrls: {}, anthropic: {} });
const q = await C.call("Twelve Data", "get_quote", { symbol: "QQQ" }); assert.match(q.payload.result, /^symbol;close;previous_close;percent_change/); assert.match(q.payload.result, /QQQ;101.5;100;1.5/);
const ts = await C.call("Twelve Data", "get_time_series", { symbol: "QQQ", interval: "5min", outputsize: 10 });
assert.match(ts.payload.result, /^datetime;open;high;low;close;volume\n2026-10-02 15:55:00;1;2;0.5;1.5;10\n$/, "ET timestamps, after-hours bar dropped");
assert.ok(priceFallback.available({ fmp: "x" }) && !priceFallback.available({}));
const st = C.status(); assert.equal(st["News APIs"], "2 providers"); assert.match(st["Twelve Data"], /fallback/);
console.log("newstest ok");
