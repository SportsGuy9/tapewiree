# Tapewire relay

A small scraper that runs on GitHub Actions every ~5 minutes (`.github/workflows/tapewire-relay.yml`).
It fetches the news feeds and market-data endpoints the Tapewire page reads (`sources.json`), trims them
(feeds keep their own format, 30 newest items, no full-article HTML) and force-pushes compact bundles to
the `feeds` branch: `news.json`, `crypto.json`, `fx.json`, `aster.json` and `status.json`.

The page reads those bundles through whichever fetch connector is healthy (TinyFish, then Firecrawl), so
one request replaces dozens and no single scraping vendor is load-bearing. Anything missing or stale in
the bundle is fetched by the page directly, as before.

Run it locally: `node relay/scrape.mjs out` (Node 20+, no dependencies).
Regenerate `sources.json` when the page's feed or job lists change.
