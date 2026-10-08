// One-off: fetch a list of public market-data URLs (relay/audit-urls.json) and save each response, for an offline replay audit of the idea ledger.
import { readFile, writeFile, mkdir } from "node:fs/promises";
const urls = JSON.parse(await readFile(new URL("./audit-urls.json", import.meta.url), "utf8"));
const out = process.argv[2] || "audit-out"; await mkdir(out, { recursive: true });
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
let k = 0; const idx = [];
for (const u0 of urls) {
  k++; let last = null;
  for (let a = 0; a < 6; a++) {
    const u = a % 2 ? u0.replace("query2.", "query1.") : u0;
    try { const r = await fetch(u, { headers: { "user-agent": UA, accept: "application/json" } }); const t = await r.text(); last = { k, u: u0, s: r.status, n: t.length };
      if (r.ok) { await writeFile(`${out}/${k}.json`, t); break; } } catch (e) { last = { k, u: u0, e: String(e) }; }
    await new Promise((r) => setTimeout(r, 15000 * (a + 1)));
  }
  idx.push(last); await new Promise((r) => setTimeout(r, /yahoo/.test(u0) ? 5000 : 600));
}
await writeFile(`${out}/index.json`, JSON.stringify(idx, null, 1)); console.log(idx.map((x) => `${x.k} ${x.s ?? x.e} ${x.n ?? ""}`).join("\n"));
