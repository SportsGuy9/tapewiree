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

On the first run the launcher creates a `.env` file. Add keys there, then restart:

| Key | What it turns on | Cost |
|---|---|---|
| `ANTHROPIC_API_KEY` | Briefings, idea generation and its desk huddle, Ask the desk, event analysis, post-mortems, the context tree, the morning deep note | Pay per use ([console.anthropic.com](https://console.anthropic.com)) |
| `TWELVEDATA_API_KEY` | Stock/ETF quotes and QQQ 5-minute bars (used for P&L marks and for measuring how the Nasdaq reacted to news) | Free tier |
| `ALPHAVANTAGE_API_KEY` | News with sentiment scores | Free tier (25 calls/day) |
| `TAVILY_API_KEY` | An extra news search source (optional) | Free tier |
| `FIRECRAWL_API_KEY` | Only used when a site blocks a direct fetch (optional) | Paid |

**Without any keys** these still work: 50+ news feeds (Bloomberg, CNBC, FT, ForexLive, Fed, ECB, BLS, Google News desks, crypto outlets, SEC 8-Ks, Nasdaq halts, StockTwits, Reddit), news search, Yahoo futures/index/yield/commodity quotes, Kalshi Fed odds, CNN Fear & Greed, FRED credit and liquidity, the earnings calendar, Treasury auctions, the economic calendar, Crypto.com prices and candles, the whole-market stock screen, the FX desk and SEC EDGAR data. These are all fetched directly and cost nothing.

CoinMarketCap and Bigdata.com were claude.ai connectors with no free REST equivalent. To use them, copy `tapewire.config.example.json` to `tapewire.config.json` and fill in the `mcp` block with your key. Check the server URL and header name against the provider's MCP docs.

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

## Files

```
public/index.html     the app (one page)
public/runtime.js     the window.claude runtime the page talks to
server/server.js      HTTP server and API routes
server/db.js          document store (data/db/docs, one JSON file per document)
server/connectors.js  data sources: direct adapters and optional remote MCP servers
server/ai.js          Claude API (one streamed turn per request; the page runs the tool loop)
server/config.js      reads .env and tapewire.config.json
```

`npm run check` runs an offline self-test of the store.

## Notes and limits
- Collection only happens while a Tapewire tab is open. The claude.ai background watcher, which collected while the page was closed and pushed alerts to your phone, does not exist here.
- The server listens on `127.0.0.1` only. If you set `HOST=0.0.0.0` to reach it from other devices, anyone on your network can read and change the library, because there is no login.
- Some sites rate-limit or block automated requests from time to time. A blocked feed backs off by itself and shows its status under **Sources & keys**.
- To move your library to another computer, copy the `data` folder, or download a backup and restore it there.
