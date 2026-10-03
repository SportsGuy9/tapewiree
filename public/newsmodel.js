/* Tapewire news model: learns which headlines move markets from the library's own measured reactions.

   Data:     one row per measured headline: its text, outlet, feed, category, tickers, entities, timing, regime,
             tone, novelty, source count and data surprise, joined with what NQ / QQQ (and the 10-year yield,
             and the stock itself versus the Nasdaq) did in the hour after it.
   Targets:  moves are first normalised by the volatility of the time (a trailing median of measured moves, per
             instrument), so a 0.3% hour in a calm week and a 0.9% hour in a wild week are judged on the same scale.
             Cross-asset: every measured instrument (index futures, VIX, Treasury yields, the dollar and FX pairs,
             oil/gold/silver/copper/gas, crypto, ETFs and sectors, and each stock a headline names) is a target:
               any    P(a big move in any major market: NQ, ES, 10Y, DXY, oil, gold, BTC, EURUSD, USDJPY, or the named stock)
               xa     P(big move in instrument A | headline)   one model over (headline x instrument) pairs, with
                      instrument and asset-class interactions, so it learns "OPEC -> oil, CAD", "BOJ -> yen", "FDA -> the stock"
               xd     P(instrument A rises | it moved meaningfully)
               xc     P(A's first-hour move keeps going over the next three hours | it moved meaningfully): continuation vs fade
               big    P(NQ move >= 1.5x a typical hour)            logistic
               mag    log(1 + move / typical)                       ridge regression
               dir    P(NQ up | the move was meaningful)            logistic
               rates  P(10-year move >= 1.5x typical)               logistic
               stock  P(stock beats/lags Nasdaq by >= 1.5x typical) logistic (company headlines)
   Model:    sparse linear models over hashed features (unigrams, bigrams, categorical values, interactions),
             trained with AdaGrad + L2, recency-weighted (half-life 60 days).
   Checks:   walk-forward validation (expanding window, 3 folds) against the rule-based importance score.
             The model only drives importance when it beats the rules on unseen data (champion/challenger).
   Works in the browser (window.TWNewsModel) and in Node (module.exports) for tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api; else root.TWNewsModel = api;
  // loaded as a Web Worker: train off the page's main thread
  if (typeof importScripts === "function" && typeof postMessage === "function") root.onmessage = (ev) => { try { postMessage({ ok: true, res: api.train(ev.data.recs, ev.data.opt || {}) }); } catch (e) { postMessage({ ok: false, error: String(e && e.message || e) }); } };
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const VERSION = 2;
  const DIM = 1 << 16;
  const DAYMS = 864e5;
  const STOP = new Set("a an the and or for with from that this these those after before over under into amid about than more most new says said will would could can may might has have had not but what why how who when where which their there they them his her our your you just still also out week weeks today stock stocks market markets shares report reports its are was were been being here near next last first year years month day days time to of in on at by as is be it up down vs via".split(" "));
  const ET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });

  /* the instrument panel: key -> [asset class, words that mean the headline is about it] */
  const ASSETS = {
    NQ: ["index", /\bnasdaq\b|tech stocks|\bnq\b/], ES: ["index", /s&p|wall street|stock market|\bes\b/], RTY: ["index", /russell|small[- ]caps?/], YM: ["index", /\bdow\b/], VIX: ["vol", /\bvix\b|volatility/],
    US10Y: ["rates", /treasur|yields?|bonds?|10-year/], US2Y: ["rates", /2-year|two-year|treasur|yields?|fed\b/], US5Y: ["rates", /5-year|treasur|yields?/],
    DXY: ["fx", /dollar|greenback|\bdxy\b/], EURUSD: ["fx", /\beuro\b|\becb\b|lagarde|eurozone|\beur\b/], USDJPY: ["fx", /\byen\b|\bboj\b|japan|ueda/], GBPUSD: ["fx", /sterling|pound|\bboe\b|bank of england|\bgbp\b/], AUDUSD: ["fx", /aussie|australia|\brba\b|\baud\b/], USDCAD: ["fx", /loonie|canad|\bcad\b/], USDCHF: ["fx", /swiss|franc|\bsnb\b/], NZDUSD: ["fx", /kiwi|new zealand|rbnz/], USDCNH: ["fx", /yuan|renminbi|pboc|china/], USDMXN: ["fx", /peso|mexic|banxico/], EURJPY: ["fx", /\byen\b|\beuro\b/], GBPJPY: ["fx", /sterling|\byen\b/],
    WTI: ["commodity", /\boil\b|crude|opec|brent|\bwti\b|hormuz|refiner/], GOLD: ["commodity", /\bgold\b|bullion/], SILVER: ["commodity", /silver/], COPPER: ["commodity", /copper/], NATGAS: ["commodity", /natural gas|\blng\b|natgas/],
    BTC: ["crypto", /bitcoin|\bbtc\b|crypto/], ETH: ["crypto", /ether(eum)?|\beth\b|crypto/], SOL: ["crypto", /solana|\bsol\b|crypto/],
    QQQ: ["etf", /nasdaq|tech stocks/], SMH: ["sector", /chip|semiconductor|nvidia|tsmc|\bhbm\b|micron|broadcom/], IWM: ["etf", /russell|small[- ]caps?/], TLT: ["rates", /treasur|long bond|30-year/], HYG: ["credit", /junk|high[- ]yield|credit spread|default/],
    XLK: ["sector", /tech|software|apple|microsoft/], XLF: ["sector", /bank|financial|lender|jpmorgan|goldman/], XLE: ["sector", /energy|oil|exxon|chevron/], XLV: ["sector", /health|pharma|biotech|\bfda\b|drug/], XLY: ["sector", /retail|consumer|amazon|tesla|auto/], XLC: ["sector", /meta|google|alphabet|netflix|media|telecom/], XLI: ["sector", /industrial|boeing|defen[cs]e|airline|rail/], XLP: ["sector", /staples|food|beverage|walmart|costco/], XLU: ["sector", /utilit|power grid|electricity/], XLRE: ["sector", /real estate|reit|housing|mortgage/], XLB: ["sector", /materials|chemical|mining|steel/]
  };
  const CORE = ["NQ", "ES", "US10Y", "DXY", "WTI", "GOLD", "BTC", "EURUSD", "USDJPY"];
  const assetClass = (k) => ASSETS[k]?.[0] || "stock";
  const DIMX = 1 << 18;
  function fnv(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  const hidx = (name, dim = DIM) => fnv(name) % dim;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sigmoid = (z) => 1 / (1 + Math.exp(-clamp(z, -30, 30)));
  const logit = (p) => Math.log(clamp(p, 1e-4, 1 - 1e-4) / (1 - clamp(p, 1e-4, 1 - 1e-4)));
  const round = (v, d = 3) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

  function tokens(title) {
    const out = [];
    for (let w of String(title || "").toLowerCase().replace(/[’']s\b/g, "").replace(/[^a-z0-9%$.\- ]+/g, " ").split(/\s+/)) {
      w = w.replace(/^[.\-]+|[.\-]+$/g, "");
      if (w.length < 2 || STOP.has(w)) continue;
      if (/^\d+(\.\d+)?%$/.test(w)) w = "<pct>"; else if (/^\$?\d[\d,.]*[kmbt]?$/.test(w)) w = "<num>";
      else if (w.length > 4 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
      else if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
      else if (w.length > 6 && w.endsWith("ing")) w = w.slice(0, -3);
      else if (w.length > 5 && w.endsWith("ed")) w = w.slice(0, -2);
      out.push(w);
    }
    return out.slice(0, 30);
  }
  /* small finance lexicon (stems, matching tokens()) for headlines that arrive without a sentiment score */
  const LEX = {
    pos: new Set("beat surge soar jump rally record raise upgrade approv strong gain rise rebound boost exceed top bullish buyback outperform win expand accelerat recover optimis profit high".split(" ")),
    neg: new Set("miss plunge tumble slump drop fall downgrade probe lawsuit weak warn recall halt bankruptcy default layoff tariff sanction strike war attack selloff sell-off bearish delay fraud investigat lower cut shortfall crash slash suspend underperform loss fear concern".split(" ")),
    hawk: new Set("hike hawkish tighten hot sticky higher-for-longer reaccelerat overheat".split(" ")),
    dove: new Set("dovish eas pause slowdown cool soft disinflation".split(" "))
  };
  function lexicon(tk) { const c = { pos: 0, neg: 0, hawk: 0, dove: 0 }; for (const w of tk) for (const k in LEX) if (LEX[k].has(w) || [...LEX[k]].some((x) => x.length >= 5 && w.startsWith(x))) c[k]++; return c; }
  function etBucket(t) {
    const o = {}; for (const p of ET.formatToParts(new Date(t))) o[p.type] = p.value;
    const m = (+o.hour % 24) * 60 + +o.minute; const wk = o.weekday === "Sat" || o.weekday === "Sun";
    const tod = wk ? "weekend" : m < 240 ? "overnight" : m < 570 ? "premarket" : m < 630 ? "open" : m < 840 ? "midday" : m < 960 ? "afternoon" : m < 1200 ? "postmarket" : "evening";
    return { tod, dow: wk ? "weekend" : o.weekday === "Mon" ? "mon" : o.weekday === "Fri" ? "fri" : "midweek" };
  }

  /* r: { title, cls, outlet, src, fd, tk[], ents[], sent, ri, so, nv, cal:{cons,act,prev,better}, t, rg:{r,v,y}, op, w } */
  function featurize(r) {
    const F = [];
    const add = (name, v = 1) => { if (v) F.push([name, v]); };
    add("bias");
    const cls = r.cls || "general"; add("c=" + cls);
    if (r.outlet) add("o=" + r.outlet);
    if (r.src) add("src=" + r.src);
    if (r.fd) add("fd=" + r.fd);
    const tk = tokens(r.title); const n = Math.max(1, tk.length); const wv = 1 / Math.sqrt(n);
    for (const w of new Set(tk)) add("w=" + w, wv);
    for (let i = 0; i + 1 < tk.length; i++) add("b=" + tk[i] + "_" + tk[i + 1], 0.7 * wv);
    const lx = lexicon(tk); add("lex_pos", Math.min(1, lx.pos / 2)); add("lex_neg", Math.min(1, lx.neg / 2)); add("hawk", Math.min(1, lx.hawk)); add("dove", Math.min(1, lx.dove));
    if (lx.hawk && /fed|fomc|powell|rate|yield|inflation|cpi|pce/.test(tk.join(" "))) add("hawk&macro");
    for (const t of (r.tk || []).slice(0, 6)) add("tk=" + t);
    add("ntk=" + Math.min(3, (r.tk || []).length));
    for (const e of (r.ents || []).slice(0, 8)) add("e=" + e);
    const tb = r.t ? etBucket(r.t) : { tod: "?", dow: "?" };
    add("tod=" + tb.tod); add("dow=" + tb.dow); add("c=" + cls + "&tod=" + tb.tod);
    if (r.rg) { add("rg=" + r.rg.r); add("vol=" + r.rg.v); add("yl=" + r.rg.y); add("c=" + cls + "&vol=" + r.rg.v); add("c=" + cls + "&rg=" + r.rg.r); }
    if (Number.isFinite(r.ri)) add("ri", r.ri / 10);
    if (Number.isFinite(r.sent)) { add("sent_abs", Math.min(1, Math.abs(r.sent) * 2)); if (r.sent >= 0.15) add("sent_pos"); if (r.sent <= -0.15) add("sent_neg"); }
    if (Number.isFinite(r.so)) add("so", Math.log2(1 + r.so) / 3);
    if (r.nv > 0) add("nv_new"); if (r.nv < 0) add("nv_rehash");
    if (/\d/.test(r.title || "")) add("has_num"); if (/%/.test(r.title || "")) add("has_pct"); if (/\?\s*$/.test(r.title || "")) add("question");
    if (r.op) add("opinion"); if (r.w) add("watchlist");
    if (r.cal && Number.isFinite(r.cal.act) && Number.isFinite(r.cal.cons)) {
      const surp = Math.min(3, Math.abs(r.cal.act - r.cal.cons) / Math.max(Math.abs(r.cal.cons) * 0.1, 0.05));
      add("cal_surp", surp / 3); if (r.cal.better === true) add("cal_better"); if (r.cal.better === false) add("cal_worse");
    }
    const len = (r.title || "").length; add("len=" + (len < 50 ? "s" : len < 100 ? "m" : "l"));
    return F;
  }

  /* ---------------------------------------------------------------- learning */
  function rollingScale(rows, key) {
    // trailing median of |move| over the previous 30 days (up to 400 rows), so volatility regimes don't masquerade as news
    const all = rows.map((r) => Math.abs(r[key])).filter(Number.isFinite).sort((a, b) => a - b);
    const glob = all.length ? all[Math.floor(all.length / 2)] : 0.1; const out = []; const win = [];
    for (const r of rows) {
      while (win.length && (r.t - win[0].t > 30 * DAYMS || win.length > 400)) win.shift();
      let s = glob;
      if (win.length >= 15) { const v = win.map((x) => x.a).sort((a, b) => a - b); s = v[Math.floor(v.length / 2)]; }
      out.push(Math.max(s, key === "y10" ? 0.6 : 0.03));
      if (Number.isFinite(r[key])) win.push({ t: r.t, a: Math.abs(r[key]) });
    }
    return out;
  }
  /* trailing 30-day median |move| for one instrument at each time it was measured */
  function seriesScale(points, floor) {
    const all = points.map((p) => Math.abs(p.v)).sort((a, b) => a - b); const glob = all.length ? all[Math.floor(all.length / 2)] : floor; const win = []; const out = new Map();
    for (const p of points) {
      while (win.length && (p.t - win[0].t > 30 * DAYMS || win.length > 300)) win.shift();
      let s = glob; if (win.length >= 12) { const v = win.map((x) => x.a).sort((a, b) => a - b); s = v[Math.floor(v.length / 2)]; }
      out.set(p, Math.max(s, floor)); win.push({ t: p.t, a: Math.abs(p.v) });
    }
    return out;
  }
  const FLOOR = { rates: 0.4, vol: 0.5, fx: 0.01, crypto: 0.05, stock: 0.05 };
  /* r.mv: { instrument: move (percent; basis points for yields) }, r.mvS: { ticker: move relative to the Nasdaq } */
  function assetMoves(r) {
    const out = {};
    for (const [k, v] of Object.entries(r.mv || {})) if (Number.isFinite(v)) out[k] = v;
    if (out.NQ == null && Number.isFinite(r.m1)) out.NQ = r.m1;
    if (out.US10Y == null && Number.isFinite(r.y10)) out.US10Y = r.y10;
    for (const [k, v] of Object.entries(r.mvS || {})) if (Number.isFinite(v) && !ASSETS[k]) out[k] = v;
    if (Number.isFinite(r.ab) && r.tk?.[0] && !ASSETS[r.tk[0]] && out[r.tk[0]] == null) out[r.tk[0]] = r.ab;
    return out;
  }
  function pairFeatures(F, k, cls, title, tk) {
    const out = [["A=" + k, 1], ["AC=" + cls, 1]];
    const self = (tk || []).includes(k);
    const ment = cls !== "stock" && ASSETS[k]?.[1]?.test(String(title || "").toLowerCase());
    if (self) out.push(["self", 1], ["self&AC=" + cls, 1]); if (ment) out.push(["ment", 1], ["ment&AC=" + cls, 1], ["ment&A=" + k, 1]);
    for (const [nm, v] of F) {
      if (nm === "bias") continue; const pre = nm.includes("=") ? nm.slice(0, nm.indexOf("=")) : nm;
      out.push([nm, v * 0.5]);                                   // shared: news that moves everything
      out.push(["AC=" + cls + "|" + nm, v]);                       // what moves this asset class
      if (cls !== "stock" && /^(c|w|b|e|tk|lex_pos|lex_neg|hawk|dove|hawk&macro|sent_pos|sent_neg|cal_better|cal_worse|cal_surp)$/.test(pre)) out.push(["A=" + k + "|" + nm, v]); // what moves this instrument
    }
    return out;
  }
  function buildDataset(recs) {
    const rows = recs.filter((r) => r.t && r.title && (Number.isFinite(r.m1) || Object.keys(r.mv || {}).length)).sort((a, b) => a.t - b.t);
    // per-instrument volatility scales (stocks share one pooled scale: each name is measured too rarely)
    const pts = {}; const mvOf = rows.map((r) => assetMoves(r));
    rows.forEach((r, i) => { for (const [k, v] of Object.entries(mvOf[i])) { const key = assetClass(k) === "stock" ? "$stock" : k; (pts[key] ||= []).push({ t: r.t, v, i, k }); } });
    const z = rows.map(() => ({})); const latest = {};
    for (const [key, list] of Object.entries(pts)) { const cls = key === "$stock" ? "stock" : assetClass(key); const sc = seriesScale(list, FLOOR[cls] ?? 0.03); for (const p of list) z[p.i][p.k] = { z: Math.abs(p.v) / sc.get(p), v: p.v }; if (list.length) latest[key] = sc.get(list[list.length - 1]); }
    // continuation: did a meaningful first-hour move keep going (same direction) between hour 1 and hour 4?
    const cont = (r, k, x) => { const v4 = r.mv4?.[k]; if (!Number.isFinite(v4) || x.z < 0.75) return null; const d = v4 - x.v; return Math.abs(d) < 1e-9 ? null : Math.sign(d) === Math.sign(x.v) ? 1 : 0; };
    const out = rows.map((r, i) => {
      const f = featurize(r); const zz = z[i];
      const nq = zz.NQ; const zy = zz.US10Y; const stk = Object.entries(zz).find(([k]) => assetClass(k) === "stock");
      const coreZ = Object.entries(zz).filter(([k]) => CORE.includes(k) || assetClass(k) === "stock").map(([, x]) => x.z);
      const pairs = Object.entries(zz).map(([k, x]) => ({ k, cls: assetClass(k), z: x.z, big: x.z >= 1.5 ? 1 : 0, up: x.z >= 0.5 ? (x.v > 0 ? 1 : 0) : null, c: cont(r, k, x), f: pairFeatures(f, k, assetClass(k), r.title, r.tk) }));
      return { r, t: r.t, f, z: nq ? nq.z : null, big: nq ? (nq.z >= 1.5 ? 1 : 0) : null, mag: nq ? Math.log1p(nq.z) : null, up: nq && nq.z >= 0.5 ? (nq.v > 0 ? 1 : 0) : null,
        ybig: zy ? (zy.z >= 1.5 ? 1 : 0) : null, sbig: stk ? (stk[1].z >= 1.5 ? 1 : 0) : null, any: coreZ.length ? (Math.max(...coreZ) >= 1.75 ? 1 : 0) : null, pairs, ri: Number.isFinite(r.ri) ? r.ri : 5, sent: r.sent };
    });
    out.scale = latest; return out;
  }
  function hashRow(f, dim = DIM) { return f.map(([name, v]) => [hidx(name, dim), v]); }
  function trainHead(rows, target, kind, opt = {}) {
    const dim = opt.dim || DIM; const w = new Float64Array(dim), g2 = new Float64Array(dim).fill(1e-6);
    const lr = kind === "linear" ? 0.06 : 0.12, l2 = opt.l2 ?? 2e-4, epochs = opt.epochs ?? 6;
    const use = rows.filter((x) => x[target] != null);
    if (use.length < 20) return null;
    const newest = use[use.length - 1].t; const half = opt.half ?? 60 * DAYMS;
    const sw = use.map((x) => Math.pow(0.5, (newest - x.t) / half));
    const H = use.map((x) => x.h || (x.h = hashRow(x.f, dim)));
    let seed = 7; const order = use.map((_, i) => i);
    let mean = 0; if (kind === "linear") { let s = 0, ws = 0; use.forEach((x, i) => { s += x[target] * sw[i]; ws += sw[i]; }); mean = s / ws; }
    for (let ep = 0; ep < epochs; ep++) {
      for (let i = order.length - 1; i > 0; i--) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; const j = seed % (i + 1); [order[i], order[j]] = [order[j], order[i]]; }
      for (const k of order) {
        const h = H[k]; let z = kind === "linear" ? mean : 0; for (const [i, v] of h) z += w[i] * v;
        const p = kind === "linear" ? z : sigmoid(z);
        const err = (p - use[k][target]) * sw[k];
        for (const [i, v] of h) { const g = err * v + l2 * w[i]; g2[i] += g * g; w[i] -= (lr / Math.sqrt(g2[i])) * g; }
      }
    }
    return { kind, w, dim, mean, n: use.length, pos: kind === "linear" ? null : use.reduce((a, x) => a + x[target], 0) / use.length };
  }
  function scoreHead(head, h) { if (!head) return null; let z = head.kind === "linear" ? head.mean : 0; for (const [i, v] of h) z += (head.w[i] || 0) * v; return head.kind === "linear" ? z : sigmoid(z); }

  /* ---------------------------------------------------------------- evaluation */
  function auc(scores, labels) {
    const idx = scores.map((s, i) => [s, labels[i]]).filter((x) => x[1] != null && Number.isFinite(x[0])).sort((a, b) => a[0] - b[0]);
    const P = idx.filter((x) => x[1] === 1).length, N = idx.length - P; if (!P || !N) return null;
    let rank = 0, sumP = 0; for (let i = 0; i < idx.length;) { let j = i; while (j < idx.length && idx[j][0] === idx[i][0]) j++; const avg = (i + j + 1) / 2; for (let k = i; k < j; k++) if (idx[k][1] === 1) sumP += avg; i = j; rank = j; }
    return (sumP - (P * (P + 1)) / 2) / (P * N);
  }
  function spearman(a, b) {
    const n = a.length; if (n < 5) return null;
    const rk = (v) => { const o = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]); const r = new Array(n); for (let i = 0; i < n;) { let j = i; while (j < n && o[j][0] === o[i][0]) j++; for (let k = i; k < j; k++) r[o[k][1]] = (i + j - 1) / 2; i = j; } return r; };
    const ra = rk(a), rb = rk(b); const ma = (n - 1) / 2; let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - ma); da += (ra[i] - ma) ** 2; db += (rb[i] - ma) ** 2; }
    return da && db ? num / Math.sqrt(da * db) : null;
  }
  function calibration(p, y, bins = 5) {
    const xs = p.map((v, i) => [v, y[i]]).filter((x) => x[1] != null).sort((a, b) => a[0] - b[0]); const out = []; if (!xs.length) return out;
    for (let b = 0; b < bins; b++) { const s = xs.slice(Math.floor((b * xs.length) / bins), Math.floor(((b + 1) * xs.length) / bins)); if (!s.length) continue; out.push({ p: round(s.reduce((a, x) => a + x[0], 0) / s.length), y: round(s.reduce((a, x) => a + x[1], 0) / s.length), n: s.length }); }
    return out;
  }
  function evaluate(H, test) {
    const hs = test.map((x) => x.h || (x.h = hashRow(x.f)));
    const pb = hs.map((h) => scoreHead(H.big, h)), pm = hs.map((h) => scoreHead(H.mag, h)), pd = hs.map((h) => scoreHead(H.dir, h));
    const big = test.map((x) => x.big); const brier = pb.reduce((a, p, i) => a + (p - big[i]) ** 2, 0) / test.length; const base = big.reduce((a, b) => a + b, 0) / test.length;
    const dirRows = test.map((x, i) => [x.up, pd[i], x.sent]).filter((x) => x[0] != null && x[1] != null);
    const dirAcc = dirRows.length ? dirRows.filter((x) => (x[1] >= 0.5 ? 1 : 0) === x[0]).length / dirRows.length : null;
    const upRate = dirRows.length ? dirRows.filter((x) => x[0] === 1).length / dirRows.length : null;
    const dirBase = upRate == null ? null : Math.max(upRate, 1 - upRate);
    const pr = test.map((x, i) => [x.ybig, scoreHead(H.rates, hs[i])]).filter((x) => x[0] != null && x[1] != null);
    const ps = test.map((x, i) => [x.sbig, scoreHead(H.stock, hs[i])]).filter((x) => x[0] != null && x[1] != null);
    // precision of the top fifth of headlines by each score: how often "flagged" actually moved NQ
    const topK = (scores) => { const k = Math.max(1, Math.floor(test.length / 5)); const o = scores.map((s, i) => [s, big[i]]).sort((a, b) => b[0] - a[0]).slice(0, k); return o.reduce((a, x) => a + x[1], 0) / k; };
    return {
      n: test.length, baseRate: round(base), auc: round(auc(pb, big)), baseAuc: round(auc(test.map((x) => x.ri), big)),
      brier: round(brier), brierBase: round(base * (1 - base)), spearman: round(spearman(pm, test.map((x) => x.z))), spearmanBase: round(spearman(test.map((x) => x.ri), test.map((x) => x.z))),
      dirN: dirRows.length, dirAcc: round(dirAcc), dirBase: round(dirBase), ratesAuc: pr.length >= 20 ? round(auc(pr.map((x) => x[1]), pr.map((x) => x[0]))) : null, stockAuc: ps.length >= 20 ? round(auc(ps.map((x) => x[1]), ps.map((x) => x[0]))) : null,
      precTop: round(topK(pb)), precTopBase: round(topK(test.map((x) => x.ri))), calib: calibration(pb, big),
      ...evalAny(H, test, hs), ...evalCross(H, test)
    };
  }
  function evalAny(H, test, hs) {
    const rows = test.map((x, i) => [x.any, scoreHead(H.any, hs[i]), x.ri]).filter((x) => x[0] != null && x[1] != null);
    if (rows.length < 20) return { anyAuc: null, anyBaseAuc: null, anyN: rows.length };
    const k = Math.max(1, Math.floor(rows.length / 5)); const top = (j) => rows.slice().sort((a, b) => b[j] - a[j]).slice(0, k).reduce((a, x) => a + x[0], 0) / k;
    return { anyN: rows.length, anyAuc: round(auc(rows.map((x) => x[1]), rows.map((x) => x[0]))), anyBaseAuc: round(auc(rows.map((x) => x[2]), rows.map((x) => x[0]))), anyRate: round(rows.reduce((a, x) => a + x[0], 0) / rows.length), anyPrecTop: round(top(1)), anyPrecTopBase: round(top(2)) };
  }
  function evalCross(H, test) {
    if (!H.xa) return { xaN: 0 };
    const P = []; for (const x of test) for (const p of x.pairs) { const h = p.h || (p.h = hashRow(p.f, DIMX)); P.push({ cls: p.cls, k: p.k, big: p.big, up: p.up, c: p.c, pb: scoreHead(H.xa, h), pu: H.xd ? scoreHead(H.xd, h) : null, pc: H.xc ? scoreHead(H.xc, h) : null, ri: x.ri }); }
    if (P.length < 30) return { xaN: P.length };
    const byCls = {};
    for (const c of [...new Set(P.map((p) => p.cls))]) {
      const q = P.filter((p) => p.cls === c); if (q.length < 20) continue;
      const d = q.filter((p) => p.up != null && p.pu != null); const upr = d.length ? d.filter((p) => p.up).length / d.length : null;
      byCls[c] = { n: q.length, rate: round(q.reduce((a, p) => a + p.big, 0) / q.length), auc: round(auc(q.map((p) => p.pb), q.map((p) => p.big))), baseAuc: round(auc(q.map((p) => p.ri), q.map((p) => p.big))), dirN: d.length, dirAcc: d.length >= 15 ? round(d.filter((p) => (p.pu >= 0.5 ? 1 : 0) === p.up).length / d.length) : null, dirBase: upr == null ? null : round(Math.max(upr, 1 - upr)) };
    }
    const d = P.filter((p) => p.up != null && p.pu != null);
    const cc = P.filter((p) => p.c != null && p.pc != null); const cr = cc.length ? cc.filter((p) => p.c).length / cc.length : null;
    const xc = cc.length >= 20 ? { xcN: cc.length, xcAcc: round(cc.filter((p) => (p.pc >= 0.5 ? 1 : 0) === p.c).length / cc.length), xcBase: round(Math.max(cr, 1 - cr)), xcAuc: round(auc(cc.map((p) => p.pc), cc.map((p) => p.c))) } : { xcN: cc.length };
    return { ...xc, xaN: P.length, xaAuc: round(auc(P.map((p) => p.pb), P.map((p) => p.big))), xaBaseAuc: round(auc(P.map((p) => p.ri), P.map((p) => p.big))), xdAcc: d.length >= 20 ? round(d.filter((p) => (p.pu >= 0.5 ? 1 : 0) === p.up).length / d.length) : null, xdN: d.length, xClass: byCls };
  }
  function trainHeads(rows, opt, cross = true) {
    const H = { big: trainHead(rows, "big", "logit", opt), mag: trainHead(rows, "mag", "linear", opt), dir: trainHead(rows, "up", "logit", opt), rates: trainHead(rows, "ybig", "logit", opt), stock: trainHead(rows, "sbig", "logit", opt), any: trainHead(rows, "any", "logit", opt) };
    if (cross) {
      const pairs = []; for (const x of rows) for (const p of x.pairs) pairs.push({ t: x.t, f: p.f, h: p.h, big: p.big, up: p.up, c: p.c, _p: p });
      const o = { ...opt, dim: DIMX, epochs: 4 };
      H.xa = trainHead(pairs, "big", "logit", o); H.xd = trainHead(pairs, "up", "logit", o); H.xc = trainHead(pairs, "c", "logit", o);
      for (const q of pairs) q._p.h = q.h; // keep hashed rows for reuse
    }
    return H;
  }
  function avgMetrics(list) {
    const keys = Object.keys(list[0] || {}).filter((k) => typeof list[0][k] === "number" || list[0][k] === null);
    const out = {}; for (const k of keys) { if (k.startsWith("xClass")) continue; const v = list.map((m) => m[k]).filter(Number.isFinite); out[k] = v.length ? round(k === "n" || k === "dirN" ? v.reduce((a, b) => a + b, 0) : v.reduce((a, b) => a + b, 0) / v.length) : null; }
    out.calib = list[list.length - 1]?.calib || [];
    // per asset-class cross-asset results, averaged over folds
    const cl = {}; for (const m of list) for (const [c, v] of Object.entries(m.xClass || {})) (cl[c] ||= []).push(v);
    out.xClass = Object.fromEntries(Object.entries(cl).map(([c, vs]) => [c, Object.fromEntries(Object.keys(vs[0]).map((k) => { const a = vs.map((v) => v[k]).filter(Number.isFinite); return [k, a.length ? round(k === "n" || k === "dirN" ? a.reduce((x, y) => x + y, 0) : a.reduce((x, y) => x + y, 0) / a.length) : null]; }))]));
    return out;
  }

  /* walk-forward: train on the past, test on the next block, three times; then fit the production model on everything */
  function train(recs, opt = {}) {
    const ds = buildDataset(recs);
    if (ds.length < (opt.minRows ?? 80)) return { status: "warming", n: ds.length, need: opt.minRows ?? 80 };
    const K = 3; const start = Math.floor(ds.length * 0.55);
    const walk = (o, cross) => { const out = []; for (let k = 0; k < K; k++) { const a = start + Math.floor(((ds.length - start) * k) / K), b = start + Math.floor(((ds.length - start) * (k + 1)) / K); const tr = ds.slice(0, a), te = ds.slice(a, b); if (te.length < 10) continue; out.push(evaluate(trainHeads(tr, o, cross), te)); } return out; };
    // hyperparameters chosen by walk-forward AUC (regularisation x recency half-life) once there is enough data to tell them apart
    const grid = ds.length >= 300 && opt.tune !== false ? [[5e-5, 30], [5e-5, 90], [2e-4, 30], [2e-4, 90], [1e-3, 30], [1e-3, 90]] : [[opt.l2 ?? 2e-4, (opt.half ?? 60 * DAYMS) / DAYMS]];
    let best = null;
    const score = (m) => (m.anyAuc ?? m.auc ?? 0) + (m.auc ?? 0);
    for (const [l2, half] of grid) { const o = { ...opt, l2, half: half * DAYMS }; const f = walk(o, grid.length === 1); const m = avgMetrics(f); if (!best || score(m) > score(best.m)) best = { o, f, m, l2, half }; }
    const folds = grid.length === 1 ? best.f : walk(best.o, true); const metrics = avgMetrics(folds); const hyper = { l2: best.l2, halfLifeDays: best.half, tried: grid.length };
    const H = trainHeads(ds, best.o, true);
    // importance follows the cross-market "any" head when it has enough data, otherwise the NQ head
    const impHead = metrics.anyAuc != null && (metrics.anyN || 0) >= 40 ? "any" : "big";
    const iA = impHead === "any" ? metrics.anyAuc : metrics.auc, iB = impHead === "any" ? metrics.anyBaseAuc : metrics.baseAuc;
    const lift = (iA ?? 0.5) - (iB ?? 0.5);
    const active = (impHead === "any" ? metrics.anyN : metrics.n) >= 40 && (iA ?? 0) >= 0.55 && lift >= 0.015;
    const strength = active ? clamp(lift / 0.1, 0.3, 1) : 0;
    const ok = { xc: (metrics.xcN || 0) >= 30 && (metrics.xcAuc ?? 0) >= 0.58 && (metrics.xcAcc ?? 0) >= (metrics.xcBase ?? 1) + 0.02, xa: (metrics.xaAuc ?? 0) >= 0.6 && (metrics.xaAuc ?? 0) > (metrics.xaBaseAuc ?? 0.5), xd: (metrics.xdAcc ?? 0) >= 0.55, dir: (metrics.dirN || 0) >= 40 && (metrics.dirAcc ?? 0) >= (metrics.dirBase ?? 0.5) + 0.03, rates: (metrics.ratesAuc ?? 0) >= 0.6, stock: (metrics.stockAuc ?? 0) >= 0.6, mag: (metrics.spearman ?? 0) >= (metrics.spearmanBase ?? 0) + 0.05 };
    // what drives each head, by feature family (names come from the training rows, weights from the production fit)
    const names = new Map(); for (const x of ds) for (const [nm] of x.f) if (!names.has(nm)) names.set(nm, hidx(nm));
    const top = {};
    for (const [hk, head] of Object.entries(H)) {
      if (!head || hk === "xa" || hk === "xd" || hk === "xc") continue;
      const fam = {}; for (const [nm, i] of names) { if (nm === "bias") continue; const f = nm.split("=")[0].split("&")[0]; (fam[f] ||= []).push([nm, head.w[i]]); }
      top[hk] = {}; for (const [f, arr] of Object.entries(fam)) { arr.sort((a, b) => b[1] - a[1]); top[hk][f] = { up: arr.slice(0, 12).filter((x) => x[1] > 0.01).map((x) => [x[0].replace(/^[^=]*=/, ""), round(x[1])]), down: arr.slice(-12).reverse().filter((x) => x[1] < -0.01).map((x) => [x[0].replace(/^[^=]*=/, ""), round(x[1])]) }; }
    }
    // what moves each asset class and each instrument (from the cross-asset head's interaction weights)
    const xnames = new Map(); for (const x of ds) for (const p of x.pairs) for (const [nm] of p.f) if (nm.startsWith("AC=") || nm.startsWith("A=")) if (!xnames.has(nm)) xnames.set(nm, hidx(nm, DIMX));
    const xtop = { cls: {}, asset: {} };
    if (H.xa) {
      const g = {}; for (const [nm, i] of xnames) { const m = /^(AC|A)=([^|]+)\|(w|b|e|c|tk|lex_pos|lex_neg|hawk|dove|hawk&macro|sent_pos|sent_neg|cal_better|cal_worse)(=(.*))?$/.exec(nm); if (!m) continue; const bucket = m[1] === "AC" ? "cls" : "asset"; ((g[bucket] ||= {})[m[2]] ||= []).push([m[5] ? m[5] : m[3], H.xa.w[i], m[3]]); }
      for (const b of ["cls", "asset"]) for (const [k, arr] of Object.entries(g[b] || {})) { arr.sort((x, y) => y[1] - x[1]); const seen = new Set(); const up = arr.filter((x) => x[1] > 0.02 && !seen.has(x[0]) && seen.add(x[0])).slice(0, 10).map((x) => [x[0], round(x[1])]); if (up.length) xtop[b][k] = up; }
      if (H.xd) for (const [nm, i] of xnames) { const m = /^A=([^|]+)\|(w|b|e|lex_pos|lex_neg|hawk|dove|hawk&macro)(=(.*))?$/.exec(nm); if (!m) continue; ((xtop.dir ||= {})[m[1]] ||= []).push([m[4] || m[2], H.xd.w[i]]); }
      for (const [k, arr] of Object.entries(xtop.dir || {})) { arr.sort((x, y) => y[1] - x[1]); const su = new Set(), sd = new Set(); xtop.dir[k] = { up: arr.filter((x) => x[1] > 0.02 && !su.has(x[0]) && su.add(x[0])).slice(0, 6).map((x) => [x[0], round(x[1])]), down: arr.slice().reverse().filter((x) => x[1] < -0.02 && !sd.has(x[0]) && sd.add(x[0])).slice(0, 6).map((x) => [x[0], round(x[1])]) }; }
    }
    // each instrument's base rate of big moves, so predictions can be shown as a lift over normal
    const ab = {}; for (const x of ds) for (const p of x.pairs) { const a = (ab[p.k] ||= [0, 0]); a[0]++; a[1] += p.big; }
    const assetBase = Object.fromEntries(Object.entries(ab).filter(([, a]) => a[0] >= 8).map(([k, a]) => [k, { n: a[0], rate: round((a[1] + 1) / (a[0] + 4)), typ: round(ds.scale[assetClass(k) === "stock" ? "$stock" : k], 3), unit: /^US\d/.test(k) ? "bp" : "%" }]));
    { const st = Object.values(ab).length ? Object.entries(ab).filter(([k]) => assetClass(k) === "stock") : []; const n = st.reduce((a, [, v]) => a + v[0], 0); if (n >= 8) assetBase.$stock = { n, rate: round((st.reduce((a, [, v]) => a + v[1], 0) + 1) / (n + 4)), typ: round(ds.scale.$stock, 3), unit: "%" }; }
    // suggested alert threshold: the importance level (rule score plus this model's adjustment) with the best F1 on the last fold's span
    const tail = ds.slice(start); let bestThr = null;
    const tailH = tail.map((x) => x.h || (x.h = hashRow(x.f)));
    for (let thr = 5; thr <= 9.01; thr += 0.5) {
      let tp = 0, fp = 0, fn = 0;
      tail.forEach((x, i) => { const lab = x[impHead]; if (lab == null) return; const p = scoreHead(H[impHead], tailH[i]); const imp = clamp(x.ri + adjFrom(p, H[impHead]?.pos, strength), 0, 10); const flag = imp >= thr; if (flag && lab) tp++; else if (flag) fp++; else if (lab) fn++; });
      const prec = tp + fp ? tp / (tp + fp) : 0, rec = tp + fn ? tp / (tp + fn) : 0, f1 = prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
      if (!bestThr || f1 > bestThr.f1) bestThr = { thr: round(thr, 1), prec: round(prec), rec: round(rec), f1: round(f1) };
    }
    // live track record: predictions stamped on headlines BEFORE their reaction was known (no hindsight at all)
    const lv = ds.filter((x) => Number.isFinite(x.r.pb)); const ld = lv.filter((x) => x.up != null && Number.isFinite(x.r.pu));
    const live = { n: lv.length, auc: lv.length >= 20 ? round(auc(lv.map((x) => x.r.pb), lv.map((x) => x.big))) : null, baseAuc: lv.length >= 20 ? round(auc(lv.map((x) => x.ri), lv.map((x) => x.big))) : null, dirN: ld.length, dirAcc: ld.length >= 15 ? round(ld.filter((x) => (x.r.pu >= 0.5 ? 1 : 0) === x.up).length / ld.length) : null };
    // live cross-asset record: the instruments stamped on each headline at arrival (r.pa = [[asset, p, pUp], ...])
    const LP = []; for (const x of ds) { if (!Array.isArray(x.r.pa)) continue; for (const [k, p, up] of x.r.pa) { const q = x.pairs.find((y) => y.k === k); if (q && Number.isFinite(p)) LP.push({ k, p, pu: up, big: q.big, up: q.up, base: assetBase[k]?.rate ?? assetBase.$stock?.rate ?? 0.25 }); } }
    if (LP.length) {
      const dd = LP.filter((q) => q.up != null && Number.isFinite(q.pu) && Math.abs(q.pu - 0.5) >= 0.08);
      live.x = { n: LP.length, hit: round(LP.reduce((a, q) => a + q.big, 0) / LP.length), base: round(LP.reduce((a, q) => a + q.base, 0) / LP.length), auc: LP.length >= 30 ? round(auc(LP.map((q) => q.p), LP.map((q) => q.big))) : null, dirN: dd.length, dirAcc: dd.length >= 15 ? round(dd.filter((q) => (q.pu >= 0.5 ? 1 : 0) === q.up).length / dd.length) : null };
      live.x.drift = live.x.n >= 40 && live.x.hit < live.x.base * 1.1;   // stamped picks no better than each market's normal rate
    }
    return { status: "trained", version: VERSION, live, hyper, t: Date.now(), n: ds.length, folds: folds.length, metrics, active, ok, impHead, strength: round(strength), heads: packHeads(H), top, xtop, assetBase, threshold: bestThr, scale: { nq: round(median(ds.map((x) => Math.abs(x.r.m1))), 3) } };
  }
  const median = (a) => { const v = a.filter(Number.isFinite).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
  function adjFrom(p, base, strength) { if (p == null || !strength) return 0; return clamp((logit(p) - logit(base || 0.2)) * 0.9 * strength, -2.5, 2.5); }

  /* ---------------------------------------------------------------- storage and prediction */
  function packHeads(H) {
    const out = {};
    for (const [k, h] of Object.entries(H)) {
      if (!h) continue; const nz = [];
      for (let i = 0; i < h.w.length; i++) if (Math.abs(h.w[i]) > 2e-4) nz.push([i, Math.round(h.w[i] * 1e4) / 1e4]);
      nz.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
      out[k] = { kind: h.kind, dim: h.w.length, mean: round(h.mean, 5), pos: round(h.pos, 4), n: h.n, w: nz.slice(0, k[0] === "x" ? 40000 : 20000) };
    }
    return out;
  }
  const hydrated = new WeakMap();
  function hydrate(model) {
    if (!model?.heads) return null; let H = hydrated.get(model); if (H) return H; H = {};
    for (const [k, h] of Object.entries(model.heads)) { const w = new Float32Array(h.dim || DIM); for (const [i, v] of h.w || []) w[i] = v; H[k] = { kind: h.kind, mean: h.mean || 0, pos: h.pos, w }; }
    hydrated.set(model, H); return H;
  }
  function predict(model, r, opt = {}) {
    const H = hydrate(model); if (!H?.big) return null;
    const F = featurize(r); const h = F.map(([nm, v]) => [hidx(nm), v]);
    const pBig = scoreHead(H.big, h), mag = scoreHead(H.mag, h), pUp = scoreHead(H.dir, h), pRates = scoreHead(H.rates, h), pStock = (r.tk || []).length ? scoreHead(H.stock, h) : null, pAny = H.any ? scoreHead(H.any, h) : null;
    const ih = model.impHead === "any" && H.any ? H.any : H.big; const pImp = ih === H.any ? pAny : pBig;
    const contrib = F.map(([nm, v], k) => [nm, (ih.w[h[k][0]] || 0) * v]).filter((x) => x[0] !== "bias" && Math.abs(x[1]) > 0.02).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 6).map((x) => [x[0], round(x[1], 2)]);
    const out = { pBig: round(pBig), pAny: round(pAny), mult: mag == null ? null : round(Math.max(0, Math.expm1(mag)), 2), pUp: round(pUp), pRates: round(pRates), pStock: round(pStock), adj: round(adjFrom(pImp, ih.pos, model.active ? model.strength : 0), 2), ok: model.ok || {}, why: contrib };
    if (opt.assets && H.xa) out.assets = rankAssets(model, H, F, r, opt);
    return out;
  }
  /* which instruments this headline is likely to move, ranked by lift over each one's normal rate of big moves */
  function rankAssets(model, H, F, r, opt = {}) {
    // only instruments with measured history (or the stocks the headline names): unmeasured ones would rank on borrowed features
    const base = model.assetBase || {}; const known = Object.keys(base).filter((k) => ASSETS[k]);
    const keys = new Set([...(opt.universe || (known.length ? known : Object.keys(ASSETS))).filter((k) => opt.universe || !known.length || base[k]), ...(r.tk || []).filter((t) => !ASSETS[t] && /^[A-Z][A-Z.]{0,5}$/.test(t))]);
    const out = [];
    for (const k of keys) {
      const cls = assetClass(k); const pf = pairFeatures(F, k, cls, r.title, r.tk); const h = pf.map(([nm, v]) => [hidx(nm, DIMX), v]);
      const p = scoreHead(H.xa, h); const up = H.xd ? scoreHead(H.xd, h) : null; const cont = H.xc ? scoreHead(H.xc, h) : null;
      const bb = base[k] || base["$" + cls]; const b = bb?.rate ?? H.xa.pos ?? 0.2;
      out.push({ k, cls, p: round(p), base: round(b), lift: round(p / Math.max(0.02, b), 2), up: round(up), cont: round(cont), typ: bb?.typ ?? null, unit: bb?.unit || (/^US\d/.test(k) ? "bp" : "%"), known: !!base[k] });
    }
    return out.sort((a, b) => b.p * Math.min(3, b.lift) - a.p * Math.min(3, a.lift)).slice(0, opt.top || 10);
  }
  return { VERSION, ASSETS, CORE, assetClass, featurize, tokens, lexicon, buildDataset, train, predict, auc, spearman, adjFrom };
});
