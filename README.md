# Tapewire

Tapewire is a market memory desk: a live news wire scored for what moves the Nasdaq, market and macro gauges, FX, crypto and SEC desks, AI briefings, an idea generator with a graded P&L ledger, and a long-term memory that learns from its own results.

It started as a claude.ai artifact. This repository is the standalone version. It runs on your own computer and you open it in any browser. Your library is stored on disk in the `data` folder, and API keys stay in a local `.env` file.

## Quick start

1. Install [Node.js](https://nodejs.org) 20 or newer.
2. Download this repository (Code → Download ZIP, or `git clone`).
3. Start it:
   - **Windows:** double-click `start.bat`
   - **macOS:** double-click `start.command` (the first time, right-click → Open)
   - **Linux / terminal:** `./start.sh`, or `npm install` then `npm start`
4. Your browser opens **http://localhost:8787**. Leave the window running. The collector works while at least one Tapewire tab is open.

### API keys

Open **Sources & keys → API keys & connectors**, paste keys and press **Save keys**. They are written to the local `.env` file and take effect right away; **Test** checks each one with a live call. (You can also edit `.env` directly; `.env.example` lists every key.)

| Key | What it turns on | Cost |
|---|---|---|
| `ANTHROPIC_API_KEY` | Briefings, idea generation and its desk huddle, Ask the desk, event analysis, post-mortems, the context tree, the morning deep note | Pay per use |
| `TWELVEDATA_API_KEY` | Stock/ETF quotes and QQQ 5-minute bars: P&L marks and the Nasdaq reactions the news model learns from | Free tier |
| `ALPACA_API_KEY_ID` + `ALPACA_API_SECRET` | The Benzinga real-time newswire | Free (Alpaca paper account) |
| `FINNHUB_API_KEY` | Market news, company news for your watchlist; stock quotes if Twelve Data is missing | Free tier |
| `POLYGON_API_KEY` | Ticker-tagged news with sentiment; 5-minute bars if Twelve Data is missing | Free tier |
| `FMP_API_KEY` | Stock and general news; quotes and bars as a fallback | Free tier |
| `MARKETAUX_API_KEY` | Entity-tagged news with sentiment | Free tier |
| `TIINGO_API_KEY` | Ticker-tagged news | Free tier |
| `NEWSAPI_API_KEY` | US business headlines from 80+ outlets | Free developer tier |
| `BENZINGA_API_KEY` | Benzinga direct (skip if you use Alpaca) | Paid |
| `ALPHAVANTAGE_API_KEY` | News with sentiment scores | Free tier (25 calls/day) |
| `TAVILY_API_KEY` | Extra news search | Free tier |
| `FIRECRAWL_API_KEY` | Only used when a site blocks a direct fetch | Paid |
| `COINMARKETCAP_API_KEY` | Crypto tab market structure via CoinMarketCap's MCP server | Free tier |
| `BIGDATA_API_KEY` | Premium news search, tearsheet and calendar via Bigdata.com's MCP server | Paid |

With no Twelve Data key, a Finnhub, FMP or Polygon key covers quotes and 5-minute bars instead. Each news API is paced to its free-tier limit.

**Without any keys** these still work: 50+ news feeds (Bloomberg, CNBC, FT, ForexLive, Fed, ECB, BLS, Google News desks, crypto outlets, SEC 8-Ks, Nasdaq halts, StockTwits, Reddit), news search, Yahoo futures/index/yield/commodity quotes, Kalshi Fed odds, CNN Fear & Greed, FRED credit and liquidity, the earnings calendar, Treasury auctions, the economic calendar, Crypto.com prices and candles, the whole-market stock screen, the FX desk and SEC EDGAR data. These are all fetched directly and cost nothing.

CoinMarketCap and Bigdata.com are reached through their remote MCP servers once their key is set. The default addresses are `https://mcp.coinmarketcap.com/mcp` (header `X-CMC-MCP-API-KEY`) and `https://mcp.bigdata.com/` (header `X-API-KEY`). I couldn't verify them from here, so if Test fails, check the provider's MCP docs and set `COINMARKETCAP_MCP_URL` / `BIGDATA_MCP_URL`, or add a full `mcp` block in `tapewire.config.json`.

### AI model and cost

AI requests use `claude-opus-5-5`. Each request type sets its own effort level (low for quick lookups, medium by default, high for the deep note and the self-review). Server-side refusal fallback is on: if Claude declines a request, Anthropic retries it on its recommended fallback model. Turn it off with `"fallbacks": false` in `tapewire.config.json`.

Each request can read up to `TAPEWIRE_PROMPT_KB` of the library (default 160 KB, about 40k tokens). The artifact version was capped at 60 KB. A full idea run makes 6 requests (4 analysts, the PM and the risk manager). Raise the limit for more depth or lower it to spend less. Automatic memory upkeep (below) can be switched off under **Sources & keys → Watch settings**.

## What changed from the artifact

### Runs on its own
- `server/` is a small Node server. It provides what claude.ai used to provide:
  - A document store on disk (`data/db`) with live updates to open tabs. There is no longer a 5,000-document cap.
  - A connector layer that answers the same tool calls the page already made, using public APIs directly.
  - The Claude API, streamed.
- `public/runtime.js` provides the page's `window.claude.use("db" | "mcp" | "sample")` calls on top of that server. The page's code paths are otherwise unchanged.

### Bugs fixed (news and ideas)
- **One failing source stopped all collection.** An error in any one source ended the collector's whole cycle, and every source after it in the list was skipped again every 30 seconds. Each source is now isolated and retries on its next turn. The collector lease is also renewed during long cycles, so a second tab can no longer start collecting at the same time.
- **Wrong "NQ 1h after" numbers for overnight news.** For pre-market headlines the 1-hour reaction was measured from the prior day's close, so it included the whole overnight gap. That polluted the learned news model and every "past analogs" figure. Bar-based measurement now requires the headline itself to land during cash hours.
- **Catalyst board errors.** FX pairs without an ATR showed `NaN×` and were always labelled "extended". Yield moves mixed percent and basis points.
- **The company/sector analyst never saw a full article.** Saved articles had no event id, so its category lookup always failed. Now fixed.
- **Medium-impact releases never reached the idea generator.** The calendar labels them `MEDIUM`, but the filter checked for `MED`.
- **Failed headline writes were never retried.** A failed write marked those headlines as already seen, so they were skipped for the rest of the session.
- **Ideas filled at stale prices.** A market-order idea created while its market was closed (for example, a weekend or overnight stock idea) was filled at the last stale quote. It now waits and fills at the next open.
- **Background marking could undo your actions.** Marking overwrote the whole idea. If you deleted an idea, closed it by hand or clicked "I took this" while a mark was running, the mark brought the old version back. All idea writes now go through one queue and re-check the stored idea first.
- **Ideas beyond the first 20 were never marked.** With more than 20 live ideas, the same 20 were marked every cycle. The stalest ideas are now marked first.
- **"Last 20", the equity curve, recent results and the self-review used creation order.** They now sort by when each idea closed.
- **The self-review prompt was cut off.** It was hard-cut at 60,000 characters, which dropped the "existing lessons" section (so retiring a lesson never worked) and most of the closed ideas. The 6-hour briefing had the same blind cut.
- **Fractional partial-profit sizes became 10%.** A `partial_pct` given as a fraction (0.5) was divided by 100 again and clamped to 10%.
- **Smaller fixes.** The entity "surge" divided an 8-day window by 7. The catalyst board was rebuilt on every repaint just to update the tab badge.

### Memory overhaul
- **Much longer retention.** The wire loads 45 days (was 16). The library keeps 400 days of daily digests and reaction measurements (was 60–90), 60 weeks of rollups (was 12), 3,000 archived story threads (was 400), 120 days of entity mention history (was 45), 600 briefings (was 150) and 150 lessons (was 60).
- **The context tree accumulates.** Dated facts now merge across rebuilds instead of being replaced. Leaves the model leaves out survive while they are recent or have a live idea. The root narrative keeps a history, so the AI can see how the story evolved. The tree rebuilds every 4 hours on weekdays (it used to depend on an external scheduled job).
- **Lessons are reinforced, not duplicated.** When a review or post-mortem restates an existing lesson, that lesson gains a "confirmed N×" count and an updated confidence. Prompts rank lessons by confidence, confirmations and recency (top 40, was 25 in list order).
- **Automatic post-mortems.** Every closed AI idea gets a process grade (A–D), a critique of thesis and execution, and a lesson that feeds back into the lesson list. You can also run them with the "Write post-mortems" button.
- **The morning deep note is written in the app.** It used to come from an external scheduled Claude session. It is now written every weekday between 7:00 and 9:25 ET (or on demand). Each note grades the previous note's calls against what prices did and keeps a running hit rate. Past notes are archived.
- **Recall across all memory.** The new `recall_memory` tool searches daily digests, weeks, live and archived threads, every stored briefing, tree facts and leaves, themes, lessons, trade plans, release playbooks, deep notes and past ideas with their post-mortems. Ask the desk and the idea PM can call it, and Memory → Search shows its results.
- **Backups.** The whole library is backed up to `data/db/backups` every day (the last 21 are kept). The **Memory store** card shows what is stored and lets you download a backup, back up now, or restore from a file.

## The news learning system

Every notable headline's market reaction is measured 15 minutes, 1 hour and 4 hours after it lands, across asset classes:

| Class | Instruments |
|---|---|
| Index futures and volatility | NQ, ES, RTY, YM, VIX |
| Rates and credit | US 2Y, 5Y and 10Y yields (in basis points), TLT, HYG |
| Dollar and FX | DXY, EURUSD, USDJPY, GBPUSD, AUDUSD, USDCAD, USDCHF, NZDUSD, USDCNH, USDMXN, EURJPY, GBPJPY |
| Commodities | WTI crude, gold, silver, copper, natural gas |
| Crypto | BTC, ETH, SOL (around the clock, weekends included) |
| ETFs and sectors | QQQ, IWM, SMH, and the 11 SPDR sector ETFs |
| Stocks | every ticker the headline names, measured relative to the Nasdaq |

An instrument is measured only while its market trades, and only from prices that were actually refreshed. Values carried forward from an older snapshot are skipped. Each measurement is stored with the headline's text and context. Those records train a model (`public/newsmodel.js`):

- **Features:** headline words and two-word phrases, outlet, feed or provider, category, tickers, topics (Fed, Powell, Iran, OPEC, AI, chips…), time of day and weekday, market regime (risk-on or off, volatility, yields), sentiment score, a built-in finance lexicon (beat/miss, hawkish/dovish…), novelty against older story threads, how many outlets confirmed it, data-release surprise size, opinion and watchlist flags, and interactions such as category × volatility.
- **Targets, scaled by market volatility:** moves are divided by a trailing 30-day median, so a quiet week and a wild week are judged on the same scale. The model predicts:
  - the chance of an NQ hour at least 1.5× normal
  - the expected size of the move
  - its direction
  - the chance of a big 10-year yield move
  - the chance a stock beats or lags the Nasdaq sharply
  - **across asset classes:** the chance of an outsized move in *any* major market (NQ, ES, 10Y, DXY, oil, gold, BTC, EURUSD, USDJPY or the named stock). Once it has enough data, this head drives importance, so an OPEC headline that moves oil but not the Nasdaq still counts.
  - **per instrument:** one model over every (headline, instrument) pair, with instrument and asset-class interaction features, predicts each instrument's chance of a big move and its direction. It learns things like "OPEC → oil up", "BOJ → yen stronger", "Fed → yields and the dollar" and "earnings → the named stock". Each headline gets a ranked list of the markets most likely to move, with odds, lift over that instrument's normal rate and a lean.
- **Method:** sparse linear models over hashed features, trained with AdaGrad and L2 regularisation, with recent data weighted more. Regularisation strength and the recency half-life are tuned automatically by walk-forward validation. Training runs in a background Web Worker, so the page never freezes.
- **Validation:**
  - Walk-forward testing (3 expanding folds) on headlines the model never saw. Metrics: AUC, top-fifth precision, Spearman correlation, Brier score and calibration, each compared with the old rule-based score. Cross-asset results are reported per asset class (AUC and direction accuracy vs the usual side).
  - A live record of predictions stamped on each headline as it arrived, scored after its reaction was measured.
  - Champion/challenger: a retrain that tests clearly worse doesn't replace the model in use.
- **Use:** once the model beats the rule score on unseen data, it adjusts every headline's importance by up to ±2.5 points. That changes alerts, story ranking, which articles get read in full, news-bus feed priority and the catalyst board. Each headline shows the model's odds, lean, the features that drove them and the markets it is most likely to move. The catalyst board adds those markets to each story's watch list, with their reaction since the headline. The model also suggests the alert threshold with the best precision/recall trade-off.
- **Continuation vs fade:** using each market's 4-hour reaction, the model learns whether a meaningful first-hour move keeps going or reverses. It shows this only once it beats always guessing the usual outcome.
- **Live cross-asset record:** the markets the model picks for each headline are stamped as the headline arrives, then scored once their reactions are measured. If live picks stop beating each market's normal rate, the panel flags drift.

### From learning to predictions, trade ideas and context

- **News pressure** (News trades tab): which markets the last 3 hours of stories should move and which way. It adds up every story, weights each by the model's odds and lift, and fades older stories. Each row is set against how far that market has already moved: not priced yet, reacting, extended, or moving against the news.
- **Model trade candidates:** strong, directional pressure on a tradable instrument that isn't priced yet, or a first-hour move the model expects to extend. Each becomes a mechanical ticket: market entry, stop at 1.6× the instrument's normal hour, target 2R. **Log** turns it into an idea. Under Settings you can let the collector log the strongest candidates itself (at most 2 every 20 minutes). These ideas are marked and graded like any other under the setup "news model", so the desk's record shows whether the model's calls make money.
- **Move attribution:** for each big market move, the headline in the prior 75 minutes the model most expects to have caused it, or a note that no headline explains it.
- **Context everywhere:** pressure, candidates, attribution and the model read on each catalyst (which markets should move, and whether they have) all feed the PM, the red team, the huddle's news analysts, the FX desk and the briefing. Ask the desk gets a `get_news_pressure` tool. Past analogs now show each analog's biggest cross-asset movers, not just NQ.
- It retrains every 3 hours (or press **Retrain now**). Ask the desk, briefings and the idea generator read its findings. It needs about 80 measured headlines before it starts.

## Files

```
public/index.html     the app (one page)
public/runtime.js     the window.claude runtime the page talks to
server/server.js      HTTP server and API routes
server/db.js          document store (data/db/docs, one JSON file per document)
server/connectors.js  data sources: direct adapters and optional remote MCP servers
server/ai.js          Claude API (one streamed turn per request; the page runs the tool loop)
server/news.js        keyed news APIs and price fallbacks, normalised
server/keys.js        the API key registry, .env writer
public/newsmodel.js   the news learning model (browser + Node)
server/config.js      reads .env and tapewire.config.json
```

`npm run check` runs offline tests: the store, the news model on synthetic data with a known signal, and every news provider's parsing against mocked responses.

## Notes and limits
- Collection only happens while a Tapewire tab is open. The claude.ai background watcher, which collected while the page was closed and pushed alerts to your phone, does not exist here.
- The server listens on `127.0.0.1` only. If you set `HOST=0.0.0.0` to reach it from other devices, anyone on your network can read and change the library, because there is no login.
- Some sites rate-limit or block automated requests from time to time. A blocked feed backs off by itself and shows its status under **Sources & keys**.
- To move your library to another computer, copy the `data` folder, or download a backup and restore it there.
