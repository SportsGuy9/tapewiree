// One-off: fetch a list of public market-data URLs (relay/audit-urls.json) and save each response, for an offline replay audit of the idea ledger.
import { readFile, writeFile, mkdir } from "node:fs/promises";
const urls = JSON.parse(await readFile(new URL("./audit-urls.json", import.meta.url), "utf8"));
const out = process.argv[2] || "audit-out"; await mkdir(out, { recursive: true });
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
let k = 0; const idx = [];
for (const u of urls) { k++; try { const r = await fetch(u, { headers: { "user-agent": UA, accept: "application/json" } }); const t = await r.text(); await writeFile(`${out}/${k}.json`, t); idx.push({ k, u, s: r.status, n: t.length }); } catch (e) { idx.push({ k, u, e: String(e) }); } await new Promise((r) => setTimeout(r, 4000)); }
await writeFile(`${out}/index.json`, JSON.stringify(idx, null, 1)); console.log(idx.map((x) => `${x.k} ${x.s ?? x.e} ${x.n ?? ""}`).join("\n"));
