// Offline test of the news model on synthetic data with a known signal: `node server/modeltest.js`
import assert from "node:assert/strict";
import fs from "node:fs";
const mod = { exports: {} };
new Function("module", "self", fs.readFileSync(new URL("../public/newsmodel.js", import.meta.url), "utf8"))(mod, undefined);
const M = mod.exports;

let seed = 42; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const words = ["fed", "powell", "nvidia", "guidance", "oil", "tariff", "earnings", "upgrade", "merger", "analyst", "ceo", "dividend", "chip", "jobs", "cpi", "yield"];
const outlets = ["reuters", "bloomberg", "cnbc", "fool", "seekingalpha", "benzinga"];
const recs = []; const t0 = Date.parse("2026-01-05T15:00:00Z");
for (let k = 0; k < 1500; k++) {
  const ws = [words[Math.floor(rnd() * words.length)], words[Math.floor(rnd() * words.length)], words[Math.floor(rnd() * words.length)]];
  const outlet = outlets[Math.floor(rnd() * outlets.length)];
  const hawk = ws.includes("cpi") || ws.includes("powell"); const fluff = outlet === "fool" || ws.includes("dividend");
  const vol = k > 900 ? 2 : 1; // volatility regime shift halfway: normalisation must cope
  let m = (rnd() - 0.5) * 0.2 * vol;
  if (hawk) m += -(0.25 + rnd() * 0.3) * vol; // hawkish words: big down moves
  if (ws.includes("nvidia") && ws.includes("guidance")) m += 0.4 * vol;
  if (fluff) m *= 0.3;
  const ri = 4 + rnd() * 3 + (fluff ? 1.5 : 0); // the rule score is fooled by fluff
  recs.push({ t: t0 + k * 3600e3 * 2, title: ws.join(" ") + " headline", cls: hawk ? "macro" : "company", outlet, src: "nb", tk: ws.includes("nvidia") ? ["NVDA"] : [], ents: [], sent: hawk ? -0.2 : 0.1, ri, so: 1 + Math.floor(rnd() * 3), m1: m, y10: hawk ? 6 + rnd() * 4 : rnd() * 2, ab: ws.includes("nvidia") ? (rnd() - 0.5) * 3 : null });
}
const res = M.train(recs);
assert.equal(res.status, "trained");
console.log("metrics", JSON.stringify(res.metrics));
assert.ok(res.metrics.auc > 0.75, "model finds the signal");
assert.ok(res.metrics.auc > res.metrics.baseAuc + 0.1, "beats the rule score");
assert.ok(res.metrics.dirAcc > 0.7, "learns direction");
assert.ok(res.active, "champion gate opens");
const hawkP = M.predict(res, { t: Date.now(), title: "powell cpi warning", cls: "macro", outlet: "reuters", tk: [], sent: -0.2, ri: 5 });
const fluffP = M.predict(res, { t: Date.now(), title: "dividend upgrade idea", cls: "company", outlet: "fool", tk: [], sent: 0.1, ri: 7 });
console.log("hawk", JSON.stringify(hawkP)); console.log("fluff", JSON.stringify(fluffP));
assert.ok(hawkP.pBig > fluffP.pBig && hawkP.adj > 0 && fluffP.adj < 0 && hawkP.pUp < 0.5);
assert.ok(JSON.stringify(res).length < 4e6, "model fits in one document");
const warm = M.train(recs.slice(0, 30)); assert.equal(warm.status, "warming");
console.log("threshold", JSON.stringify(res.threshold), "size", Math.round(JSON.stringify(res).length / 1024), "KB");
console.log("modeltest ok");
const withLive = recs.map((r, i) => (i % 2 ? { ...r, pb: M.predict(res, r).pBig, pu: M.predict(res, r).pUp } : r));
const res2 = M.train(withLive); assert.ok(res2.live.n > 500 && res2.live.auc > 0.8, "live record scored");
console.log("live", JSON.stringify(res2.live));
