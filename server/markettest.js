// Offline test of the market model on synthetic markets with known structure: `node server/markettest.js`
//   BTC: momentum (hourly returns autocorrelated) · NQ: mean reversion to its 20h average · WTI: drifts up for hours after
//   bullish news the news model flagged · EURUSD, GOLD: pure noise (the model must NOT trust them)
import assert from "node:assert/strict";
import fs from "node:fs";
const load = (f) => { const mod = { exports: {} }; new Function("module", "self", "require", fs.readFileSync(new URL("../public/" + f, import.meta.url), "utf8"))(mod, undefined, () => null); return mod.exports; };
const MM = load("marketmodel.js");

let seed = 5; const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296); const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return (s - 3) / Math.sqrt(0.5); };
const H = 36e5; const t0 = Date.parse("2026-07-01T00:00:00Z"); const N = 24 * 60;
const P = { BTC: 60000, NQ: 20000, WTI: 70, EURUSD: 1.1, GOLD: 2400, VIX: 16, US10Y: 4.2, DXY: 100 }; const snaps = [], events = [];
let rb = 0; const nqHist = []; let wtiDrift = 0;
for (let i = 0; i < N; i++) {
  const t = t0 + i * H;
  rb = 0.4 * rb + 0.5 * gauss(); P.BTC *= Math.exp(rb / 100);                                   // momentum
  nqHist.push(P.NQ); const ma = nqHist.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, nqHist.length);
  P.NQ *= Math.exp((-0.25 * Math.log(P.NQ / ma) * 100 + 0.25 * gauss()) / 100);               // mean reversion
  if (rnd() < 0.04) { events.push({ t: t - 20 * 60e3, title: "OPEC agrees deeper output cuts", tk: [], imp: 7, sent: 0.3, src: "nb", pa: [["WTI", 0.9, 0.95]] }); wtiDrift = 6; }
  if (rnd() < 0.04) events.push({ t: t - 15 * 60e3, title: "Gold traders eye central bank buying", tk: [], imp: 6, sent: 0.1, src: "nb", pa: [["GOLD", 0.8, 0.9]] }); // gold "news" that does nothing
  P.WTI *= Math.exp(((wtiDrift > 0 ? 0.25 : 0) + 0.3 * gauss()) / 100); wtiDrift--;               // news drift
  P.EURUSD *= Math.exp(0.08 * gauss() / 100); P.GOLD *= Math.exp(0.2 * gauss() / 100);           // noise
  P.VIX = Math.max(10, P.VIX + 0.1 * gauss()); P.US10Y += 0.01 * gauss(); P.DXY *= Math.exp(0.05 * gauss() / 100);
  const q = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, [v, null, null]]));
  snaps.push({ t: t + 5 * 60e3, q, u: Object.keys(q) });
}
const t1 = Date.now(); const res = MM.train({ snaps, events, fund: {} });
console.log("trained in", Date.now() - t1, "ms;", res.n, "rows,", res.instruments, "instruments,", res.days, "days");
assert.equal(res.status, "trained");
const cell = (h, c) => res.cells[h]?.cls?.[c];
for (const [c, h] of [["crypto", 1], ["index", 1], ["commodity", 4]]) console.log(c, h + "h", JSON.stringify(cell(h, c)), "trusted", res.ok[h]?.[c]);
console.log("fx 4h", JSON.stringify(cell(4, "fx")), "trusted", res.ok[4]?.fx);
assert.ok(cell(1, "crypto").ic > 0.15 && res.ok[1].crypto, "learns crypto momentum");
assert.ok(cell(1, "index").ic > 0.1 && res.ok[1].index, "learns index mean reversion");
assert.ok(cell(4, "commodity").ic > 0.05, "learns the news drift in oil");
assert.ok(!res.ok[4]?.fx && !res.ok[1]?.fx, "does not trust pure noise");
console.log("importance 1h crypto", JSON.stringify(res.imp[1]?.cls?.crypto), "4h commodity", JSON.stringify(res.imp[4]?.cls?.commodity));
assert.ok(res.imp[4].cls.commodity.news > 0.01, "news family matters for oil");
assert.ok(res.imp[1].cls.crypto.price > 0.05, "price family drives crypto");
console.log("rules 4h crypto bull", JSON.stringify(res.rules[4].crypto?.bull?.slice(0, 4)), "commodity bull", JSON.stringify(res.rules[4].commodity?.bull?.slice(0, 4)));
// live outlook: BTC after a strong up-hour should lean up; WTI right after an OPEC headline should lean up
const tail = snaps.slice(-200); const last = tail[tail.length - 1];
const up = { ...last, t: last.t + H, q: { ...last.q, BTC: [last.q.BTC[0] * 1.015, null, null] } };
const ol = MM.outlook(res, { snaps: [...tail, up], events: [...events.slice(-20), { t: up.t - 10 * 60e3, title: "OPEC agrees deeper output cuts", tk: [], imp: 7, src: "nb", pa: [["WTI", 0.9, 0.95]] }] }, { now: up.t + 60e3 });
const btc = ol.find((o) => o.k === "BTC"), wti = ol.find((o) => o.k === "WTI");
console.log("BTC", JSON.stringify(btc.hz), JSON.stringify(btc.why)); console.log("WTI", JSON.stringify(wti.hz), JSON.stringify(wti.fam));
assert.ok(btc.hz[1].z > 0.1, "BTC momentum outlook up"); assert.ok(wti.hz[4].z > 0.05 && wti.fam.news > 0, "WTI outlook up on news");
assert.ok(JSON.stringify(res).length < 5e6, "fits in one document"); console.log("size", Math.round(JSON.stringify(res).length / 1024), "KB");
// learning from the desk's own trades: ideas with the model won, against it lost
const ideas = []; for (let i = 0; i < 90; i++) { const mm = rnd() * 2 - 1; ideas.push({ t: t0 + i * H, setup: "trend pullback", horizon: "intraday", dir: "long", cls: "index", conf: 60, src: "ai", ctx: { mm, np: 0 }, r: (mm > 0 ? 0.6 : -0.6) + gauss() * 0.8 }); }
const meta = MM.trainIdeas(ideas); console.log("meta", JSON.stringify({ n: meta.n, auc: meta.auc, ok: meta.ok, mm: meta.tables.marketModel, helps: meta.helps.slice(0, 3) }));
assert.ok(meta.tables.marketModel.with.win > meta.tables.marketModel.against.win + 0.2, "desk learns trades with the model win more");
assert.ok(MM.ideaWinP(meta, { ...ideas[0], ctx: { mm: 0.8 } }) > MM.ideaWinP(meta, { ...ideas[0], ctx: { mm: -0.8 } }));
console.log("markettest ok");
