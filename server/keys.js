// Every API key Tapewire understands, where to get it, what it unlocks, and how to test it.
// Keys are stored in the local .env file (never in the page or the library).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const KEY_SPECS = [
  { id: "anthropic", env: "ANTHROPIC_API_KEY", label: "Anthropic (Claude)", group: "AI", url: "https://console.anthropic.com/settings/keys", what: "All AI features: briefings, ideas, Ask the desk, post-mortems, the context tree, the deep note.", cost: "pay per use" },
  { id: "twelvedata", env: "TWELVEDATA_API_KEY", label: "Twelve Data", group: "Prices", url: "https://twelvedata.com/register", what: "Stock and ETF quotes and QQQ 5-minute bars: P&L marks and the Nasdaq reactions the news model learns from.", cost: "free tier (800 calls/day)" },
  { id: "finnhub", env: "FINNHUB_API_KEY", label: "Finnhub", group: "News", url: "https://finnhub.io/register", what: "Market news plus company news for your watchlist; stock quotes when Twelve Data has no key.", cost: "free tier" },
  { id: "polygon", env: "POLYGON_API_KEY", label: "Polygon.io (Massive)", group: "News", url: "https://polygon.io/dashboard/signup", what: "Ticker-tagged news with per-ticker sentiment; 5-minute bars when Twelve Data has no key.", cost: "free tier (5 calls/min)" },
  { id: "alpaca_id", env: "ALPACA_API_KEY_ID", label: "Alpaca key ID", group: "News", url: "https://app.alpaca.markets/signup", what: "With the secret below: the Benzinga real-time newswire, free with an Alpaca paper account.", cost: "free" },
  { id: "alpaca_secret", env: "ALPACA_API_SECRET", label: "Alpaca secret", group: "News", url: "https://app.alpaca.markets/signup", what: "The secret that goes with the Alpaca key ID.", cost: "free" },
  { id: "benzinga", env: "BENZINGA_API_KEY", label: "Benzinga (direct)", group: "News", url: "https://www.benzinga.com/apis/", what: "Benzinga newswire direct (skip if you use Alpaca).", cost: "paid" },
  { id: "fmp", env: "FMP_API_KEY", label: "Financial Modeling Prep", group: "News", url: "https://site.financialmodelingprep.com/developer/docs", what: "Stock and general market news; quotes and 5-minute bars as a fallback.", cost: "free tier (250 calls/day)" },
  { id: "marketaux", env: "MARKETAUX_API_KEY", label: "Marketaux", group: "News", url: "https://www.marketaux.com/register", what: "Entity-tagged news with sentiment scores.", cost: "free tier (100 calls/day)" },
  { id: "tiingo", env: "TIINGO_API_KEY", label: "Tiingo", group: "News", url: "https://www.tiingo.com/account/api/token", what: "Ticker-tagged financial news.", cost: "free tier" },
  { id: "newsapi", env: "NEWSAPI_API_KEY", label: "NewsAPI", group: "News", url: "https://newsapi.org/register", what: "US business top headlines from 80+ outlets.", cost: "free developer tier (100 calls/day)" },
  { id: "alphavantage", env: "ALPHAVANTAGE_API_KEY", label: "Alpha Vantage", group: "News", url: "https://www.alphavantage.co/support/#api-key", what: "News with per-ticker sentiment, rotating topics; quote checks.", cost: "free tier (25 calls/day)" },
  { id: "tavily", env: "TAVILY_API_KEY", label: "Tavily", group: "Search", url: "https://app.tavily.com", what: "Extra AI news search.", cost: "free tier (1,000/month)" },
  { id: "firecrawl", env: "FIRECRAWL_API_KEY", label: "Firecrawl", group: "Search", url: "https://www.firecrawl.dev/app/api-keys", what: "Only used when a website blocks a direct fetch; better web news search.", cost: "free trial, then paid" },
  { id: "cmc", env: "COINMARKETCAP_API_KEY", label: "CoinMarketCap (MCP)", group: "Crypto", url: "https://coinmarketcap.com/api/", what: "Crypto market structure, technicals, narratives and catalysts on the Crypto tab, through CoinMarketCap's MCP server. Set COINMARKETCAP_MCP_URL in .env if their address differs.", cost: "free tier" },
  { id: "bigdata", env: "BIGDATA_API_KEY", label: "Bigdata.com (MCP)", group: "News", url: "https://bigdata.com", what: "Premium news search, market tearsheet and economic calendar through Bigdata.com's MCP server. Set BIGDATA_MCP_URL in .env if their address differs.", cost: "paid credits" }
];

export const ENV_FILE = path.join(ROOT, ".env");
export function maskedKeys(cfg) {
  return KEY_SPECS.map((k) => { const v = cfg.keys[k.id] || (k.id === "anthropic" ? cfg.anthropic.apiKey : ""); return { ...k, set: !!v, hint: v ? `…${String(v).slice(-4)}` : "", fromShell: !!process.env[k.env] }; });
}
/* update .env in place: changed keys are rewritten, removed keys deleted, everything else (comments, other settings) kept */
export function writeKeys(values) {
  const allowed = new Map(KEY_SPECS.map((k) => [k.env, k]));
  let lines = []; try { lines = fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/); } catch (e) { /* new file */ }
  const done = new Set();
  for (const [env, raw] of Object.entries(values || {})) {
    if (!allowed.has(env)) throw new Error(`unknown key ${env}`);
    const v = raw == null ? "" : String(raw).replace(/[\r\n"'\s]/g, "");
    if (v.length > 300) throw new Error(`${env} is too long`);
    const i = lines.findIndex((l) => new RegExp(`^\\s*${env}\\s*=`).test(l));
    if (v) { const line = `${env}=${v}`; if (i >= 0) lines[i] = line; else lines.push(line); }
    else if (i >= 0) lines.splice(i, 1);
    done.add(env);
  }
  fs.writeFileSync(ENV_FILE, lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "") + (lines.length ? "\n" : ""), { mode: 0o600 });
  return [...done];
}
