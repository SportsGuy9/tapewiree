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

// ---- cross-asset: each instrument has its own triggers, which the pair model must learn
seed = 7; const xrecs = []; const xw = ["opec", "yen", "boj", "bitcoin", "etf", "gold", "fed", "earnings", "merger", "analyst", "ceo", "chip", "copper", "china", "jobs", "retail"];
for (let k = 0; k < 1400; k++) {
  const ws = [0, 1, 2].map(() => xw[Math.floor(rnd() * xw.length)]); const has = (w) => ws.includes(w);
  const n = (sd) => (rnd() - 0.5) * 2 * sd;
  const mv = { NQ: n(0.15), ES: n(0.1), US10Y: n(1.5), DXY: n(0.06), WTI: n(0.3), GOLD: n(0.15), BTC: n(0.5), EURUSD: n(0.05), USDJPY: n(0.06), COPPER: n(0.25) };
  if (has("opec")) mv.WTI += 1.2 + rnd() * 0.6;                       // OPEC -> oil up, nothing else
  if (has("yen") || has("boj")) mv.USDJPY -= 0.3 + rnd() * 0.2;         // BOJ/yen -> USDJPY down
  if (has("bitcoin") && has("etf")) mv.BTC += 2 + rnd();               // bitcoin ETF -> BTC up
  if (has("fed")) { mv.US10Y += 5 + rnd() * 3; mv.NQ -= 0.4; mv.DXY += 0.15; } // fed -> yields up, NQ down, dollar up
  if (has("copper") && has("china")) mv.COPPER += 1 + rnd() * 0.5;
  const tk = has("chip") ? ["NVDA"] : []; if (tk.length) mv.NVDA = n(0.5) + (has("earnings") ? 2.5 : 0);
  // 4h: OPEC oil moves keep going, BOJ yen moves fade; everything else is noise
  const mv4 = Object.fromEntries(Object.entries(mv).map(([k, v]) => [k, v + n(Math.abs(v) * 0.6 + 0.05)]));
  if (has("opec")) mv4.WTI = mv.WTI * 1.8; if (has("yen") || has("boj")) mv4.USDJPY = mv.USDJPY * 0.2;
  xrecs.push({ t: t0 + k * 3600e3 * 3, title: ws.join(" ") + " report", cls: "general", outlet: "reuters", src: "nb", tk, ents: [], sent: 0, ri: 5 + n(1), mv, mv4, m1: mv.NQ, y10: mv.US10Y });
}
const xr = M.train(xrecs);
console.log("cross", JSON.stringify({ any: [xr.metrics.anyAuc, xr.metrics.anyBaseAuc], xa: [xr.metrics.xaAuc, xr.metrics.xaBaseAuc], xd: xr.metrics.xdAcc, cls: xr.metrics.xClass, imp: xr.impHead, ok: xr.ok }));
assert.equal(xr.impHead, "any", "importance follows the any-market head");
assert.ok(xr.metrics.anyAuc > 0.75 && xr.metrics.anyAuc > xr.metrics.anyBaseAuc + 0.15, "any-market head finds the triggers");
assert.ok(xr.metrics.xaAuc > 0.8, "pair model learns which instrument moves");
assert.ok(xr.ok.xa && xr.ok.xd, "cross heads pass their gates");
for (const c of ["commodity", "fx", "crypto", "rates"]) assert.ok(xr.metrics.xClass[c]?.auc > (c === "crypto" ? 0.65 : 0.7), "learns " + c);
const top = (title, tk = []) => M.predict(xr, { t: Date.now(), title, cls: "general", outlet: "reuters", tk, sent: 0, ri: 5 }, { assets: true, top: 3 }).assets;
const opec = top("opec cuts output report"), boj = top("boj yen intervention report"), btc = top("bitcoin etf approval report"), fed = top("fed hike report"), nv = top("chip earnings report", ["NVDA"]);
console.log("opec", JSON.stringify(opec[0]), "boj", JSON.stringify(boj[0]), "btc", JSON.stringify(btc[0]), "fed", JSON.stringify(fed.slice(0, 3).map((a) => a.k)), "nvda", JSON.stringify(nv[0]));
assert.equal(opec[0].k, "WTI"); assert.ok(opec[0].up > 0.6, "oil up on OPEC");
assert.equal(boj[0].k, "USDJPY"); assert.ok(boj[0].up < 0.4, "yen strengthens on BOJ");
assert.equal(btc[0].k, "BTC"); assert.ok(btc[0].up > 0.6);
assert.ok(fed.some((a) => a.k === "US10Y"), "fed moves yields");
assert.equal(nv[0].k, "NVDA", "the named stock tops a chip earnings headline");
assert.ok(xr.xtop.asset.WTI?.some((x) => x[0] === "opec"), "learned trigger list names opec for oil");
assert.ok(JSON.stringify(xr).length < 6e6, "cross-asset model fits in one document");
console.log("size", Math.round(JSON.stringify(xr).length / 1024), "KB");
assert.ok(xr.metrics.xcN > 100, "continuation labels built");
const opecC = top("opec cuts output report")[0], bojC = top("boj yen intervention report")[0];
console.log("continuation", JSON.stringify({ acc: xr.metrics.xcAcc, base: xr.metrics.xcBase, auc: xr.metrics.xcAuc, opec: opecC.cont, boj: bojC.cont, typ: opecC.typ }));
assert.ok(opecC.cont > 0.6 && bojC.cont < 0.4, "learns oil extends, yen fades");
assert.ok(opecC.typ > 0 && opecC.unit === "%", "typical move size per instrument");
// live cross-asset record from stamped picks
const xlive = M.train(xrecs.map((r, i) => (i % 2 ? { ...r, pa: M.predict(xr, r, { assets: true, top: 4 }).assets.map((a) => [a.k, a.p, a.up]) } : r)));
console.log("live x", JSON.stringify(xlive.live.x));
assert.ok(xlive.live.x.n > 1000 && xlive.live.x.hit > xlive.live.x.base * 1.3 && !xlive.live.x.drift, "stamped picks beat base rates live");
// old-style records (NQ + 10Y + stock only) still train
const old = M.train(recs.slice(0, 600)); assert.equal(old.status, "trained");
console.log("cross-asset ok");
