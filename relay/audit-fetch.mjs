// One-off: fetch a list of public market-data URLs (relay/audit-urls.json) and save each response, for an offline replay audit of the idea ledger.
import { readFile, writeFile, mkdir } from "node:fs/promises";
const urls = JSON.parse(await readFile(new URL("./audit-urls.json", import.meta.url), "utf8"));
const out = process.argv[2] || "audit-out"; await mkdir(out, { recursive: true });
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const idx = [];
const deadline = Date.now() + 22 * 60 * 1000;
const order = urls.map((u, j) => [u, j + 1]).sort((a, b) => /yahoo/.test(a[0]) - /yahoo/.test(b[0]));
for (const [u0, kk] of order) {
  if (Date.now() > deadline) { idx.push({ k: kk, u: u0, e: "skipped (deadline)" }); continue; }
  let last = null; const tries = /yahoo/.test(u0) ? 3 : 2;
  for (let a = 0; a < tries; a++) {
    const u = a % 2 ? u0.replace("query2.", "query1.") : u0;
    try { const r = await fetch(u, { headers: { "user-agent": UA, accept: "application/json" } }); const t = await r.text(); last = { k: kk, u: u0, s: r.status, n: t.length };
      if (r.ok) { await writeFile(`${out}/${kk}.json`, t); break; } } catch (e) { last = { k: kk, u: u0, e: String(e) }; }
    await new Promise((r) => setTimeout(r, 20000 * (a + 1)));
  }
  idx.push(last); await writeFile(`${out}/index.json`, JSON.stringify(idx, null, 1));
  await new Promise((r) => setTimeout(r, /yahoo/.test(u0) ? 6000 : 400));
}
await writeFile(`${out}/index.json`, JSON.stringify(idx, null, 1)); console.log(idx.map((x) => `${x.k} ${x.s ?? x.e} ${x.n ?? ""}`).join("\n"));
