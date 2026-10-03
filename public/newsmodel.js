/* Tapewire news model: learns which headlines move markets from the library's own measured reactions.

   Data:     one row per measured headline: its text, outlet, feed, category, tickers, entities, timing, regime,
             tone, novelty, source count and data surprise, joined with what NQ / QQQ (and the 10-year yield,
             and the stock itself versus the Nasdaq) did in the hour after it.
   Targets:  moves are first normalised by the volatility of the time (a trailing median of measured moves),
             so a 0.3% hour in a calm week and a 0.9% hour in a wild week are judged on the same scale.
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
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const VERSION = 2;
  const DIM = 1 << 16;
  const DAYMS = 864e5;
  const STOP = new Set("a an the and or for with from that this these those after before over under into amid about than more most new says said will would could can may might has have had not but what why how who when where which their there they them his her our your you just still also out week weeks today stock stocks market markets shares report reports its are was were been being here near next last first year years month day days time to of in on at by as is be it up down vs via".split(" "));
  const ET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });

  function fnv(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  const hidx = (name) => fnv(name) % DIM;
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
  function buildDataset(recs) {
    const rows = recs.filter((r) => Number.isFinite(r.m1) && r.t && r.title).sort((a, b) => a.t - b.t);
    const sN = rollingScale(rows, "m1"); const sY = rollingScale(rows, "y10"); const sS = rollingScale(rows, "ab");
    return rows.map((r, i) => {
      const z = Math.abs(r.m1) / sN[i];
      const zy = Number.isFinite(r.y10) ? Math.abs(r.y10) / sY[i] : null;
      const zs = Number.isFinite(r.ab) ? Math.abs(r.ab) / sS[i] : null;
      return { r, t: r.t, f: featurize(r), z, big: z >= 1.5 ? 1 : 0, mag: Math.log1p(z), up: z >= 0.5 ? (r.m1 > 0 ? 1 : 0) : null, ybig: zy == null ? null : zy >= 1.5 ? 1 : 0, sbig: zs == null ? null : zs >= 1.5 ? 1 : 0, ri: Number.isFinite(r.ri) ? r.ri : 5, sent: r.sent };
    });
  }
  function hashRow(f) { return f.map(([name, v]) => [hidx(name), v]); }
  function trainHead(rows, target, kind, opt = {}) {
    const w = new Float64Array(DIM), g2 = new Float64Array(DIM).fill(1e-6);
    const lr = kind === "linear" ? 0.06 : 0.12, l2 = opt.l2 ?? 2e-4, epochs = opt.epochs ?? 6;
    const use = rows.filter((x) => x[target] != null);
    if (use.length < 20) return null;
    const newest = use[use.length - 1].t; const half = opt.half ?? 60 * DAYMS;
    const sw = use.map((x) => Math.pow(0.5, (newest - x.t) / half));
    const H = use.map((x) => x.h || (x.h = hashRow(x.f)));
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
    return { kind, w, mean, n: use.length, pos: kind === "linear" ? null : use.reduce((a, x) => a + x[target], 0) / use.length };
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
      precTop: round(topK(pb)), precTopBase: round(topK(test.map((x) => x.ri))), calib: calibration(pb, big)
    };
  }
  function trainHeads(rows, opt) {
    return { big: trainHead(rows, "big", "logit", opt), mag: trainHead(rows, "mag", "linear", opt), dir: trainHead(rows, "up", "logit", opt), rates: trainHead(rows, "ybig", "logit", opt), stock: trainHead(rows, "sbig", "logit", opt) };
  }
  function avgMetrics(list) {
    const keys = Object.keys(list[0] || {}).filter((k) => typeof list[0][k] === "number" || list[0][k] === null);
    const out = {}; for (const k of keys) { const v = list.map((m) => m[k]).filter(Number.isFinite); out[k] = v.length ? round(k === "n" || k === "dirN" ? v.reduce((a, b) => a + b, 0) : v.reduce((a, b) => a + b, 0) / v.length) : null; }
    out.calib = list[list.length - 1]?.calib || []; return out;
  }

  /* walk-forward: train on the past, test on the next block, three times; then fit the production model on everything */
  function train(recs, opt = {}) {
    const ds = buildDataset(recs);
    if (ds.length < (opt.minRows ?? 80)) return { status: "warming", n: ds.length, need: opt.minRows ?? 80 };
    const folds = []; const K = 3; const start = Math.floor(ds.length * 0.55);
    for (let k = 0; k < K; k++) {
      const a = start + Math.floor(((ds.length - start) * k) / K), b = start + Math.floor(((ds.length - start) * (k + 1)) / K);
      const tr = ds.slice(0, a), te = ds.slice(a, b); if (te.length < 10) continue;
      folds.push(evaluate(trainHeads(tr, opt), te));
    }
    const metrics = avgMetrics(folds);
    const H = trainHeads(ds, opt);
    const lift = (metrics.auc ?? 0.5) - (metrics.baseAuc ?? 0.5);
    const active = metrics.n >= 40 && (metrics.auc ?? 0) >= 0.55 && lift >= 0.015;
    const strength = active ? clamp(lift / 0.1, 0.3, 1) : 0;
    const ok = { dir: (metrics.dirN || 0) >= 40 && (metrics.dirAcc ?? 0) >= (metrics.dirBase ?? 0.5) + 0.03, rates: (metrics.ratesAuc ?? 0) >= 0.6, stock: (metrics.stockAuc ?? 0) >= 0.6, mag: (metrics.spearman ?? 0) >= (metrics.spearmanBase ?? 0) + 0.05 };
    // what drives each head, by feature family (names come from the training rows, weights from the production fit)
    const names = new Map(); for (const x of ds) for (const [nm] of x.f) if (!names.has(nm)) names.set(nm, hidx(nm));
    const top = {};
    for (const [hk, head] of Object.entries(H)) {
      if (!head || head.kind === "linear") { if (!head) continue; }
      const fam = {}; for (const [nm, i] of names) { if (nm === "bias") continue; const f = nm.split("=")[0].split("&")[0]; (fam[f] ||= []).push([nm, head.w[i]]); }
      top[hk] = {}; for (const [f, arr] of Object.entries(fam)) { arr.sort((a, b) => b[1] - a[1]); top[hk][f] = { up: arr.slice(0, 12).filter((x) => x[1] > 0.01).map((x) => [x[0].replace(/^[^=]*=/, ""), round(x[1])]), down: arr.slice(-12).reverse().filter((x) => x[1] < -0.01).map((x) => [x[0].replace(/^[^=]*=/, ""), round(x[1])]) }; }
    }
    // suggested alert threshold: the importance level (rule score plus this model's adjustment) with the best F1 on the last fold's span
    const tail = ds.slice(start); let best = null;
    const tailH = tail.map((x) => x.h || (x.h = hashRow(x.f)));
    for (let thr = 5; thr <= 9.01; thr += 0.5) {
      let tp = 0, fp = 0, fn = 0;
      tail.forEach((x, i) => { const p = scoreHead(H.big, tailH[i]); const imp = clamp(x.ri + adjFrom(p, H.big?.pos, strength), 0, 10); const flag = imp >= thr; if (flag && x.big) tp++; else if (flag) fp++; else if (x.big) fn++; });
      const prec = tp + fp ? tp / (tp + fp) : 0, rec = tp + fn ? tp / (tp + fn) : 0, f1 = prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
      if (!best || f1 > best.f1) best = { thr: round(thr, 1), prec: round(prec), rec: round(rec), f1: round(f1) };
    }
    // live track record: predictions stamped on headlines BEFORE their reaction was known (no hindsight at all)
    const lv = ds.filter((x) => Number.isFinite(x.r.pb)); const ld = lv.filter((x) => x.up != null && Number.isFinite(x.r.pu));
    const live = { n: lv.length, auc: lv.length >= 20 ? round(auc(lv.map((x) => x.r.pb), lv.map((x) => x.big))) : null, baseAuc: lv.length >= 20 ? round(auc(lv.map((x) => x.ri), lv.map((x) => x.big))) : null, dirN: ld.length, dirAcc: ld.length >= 15 ? round(ld.filter((x) => (x.r.pu >= 0.5 ? 1 : 0) === x.up).length / ld.length) : null };
    return { status: "trained", version: VERSION, live, t: Date.now(), n: ds.length, folds: folds.length, metrics, active, ok, strength: round(strength), heads: packHeads(H), top, threshold: best, scale: { nq: round(median(ds.map((x) => Math.abs(x.r.m1))), 3) } };
  }
  const median = (a) => { const v = a.filter(Number.isFinite).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
  function adjFrom(p, base, strength) { if (p == null || !strength) return 0; return clamp((logit(p) - logit(base || 0.2)) * 0.9 * strength, -2.5, 2.5); }

  /* ---------------------------------------------------------------- storage and prediction */
  function packHeads(H) {
    const out = {};
    for (const [k, h] of Object.entries(H)) {
      if (!h) continue; const nz = [];
      for (let i = 0; i < DIM; i++) if (Math.abs(h.w[i]) > 2e-4) nz.push([i, Math.round(h.w[i] * 1e4) / 1e4]);
      nz.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
      out[k] = { kind: h.kind, mean: round(h.mean, 5), pos: round(h.pos, 4), n: h.n, w: nz.slice(0, 20000) };
    }
    return out;
  }
  const hydrated = new WeakMap();
  function hydrate(model) {
    if (!model?.heads) return null; let H = hydrated.get(model); if (H) return H; H = {};
    for (const [k, h] of Object.entries(model.heads)) { const w = new Float32Array(DIM); for (const [i, v] of h.w || []) w[i] = v; H[k] = { kind: h.kind, mean: h.mean || 0, pos: h.pos, w }; }
    hydrated.set(model, H); return H;
  }
  function predict(model, r) {
    const H = hydrate(model); if (!H?.big) return null;
    const F = featurize(r); const h = F.map(([nm, v]) => [hidx(nm), v]);
    const pBig = scoreHead(H.big, h), mag = scoreHead(H.mag, h), pUp = scoreHead(H.dir, h), pRates = scoreHead(H.rates, h), pStock = (r.tk || []).length ? scoreHead(H.stock, h) : null;
    const contrib = F.map(([nm, v], k) => [nm, (H.big.w[h[k][0]] || 0) * v]).filter((x) => x[0] !== "bias" && Math.abs(x[1]) > 0.02).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 6).map((x) => [x[0], round(x[1], 2)]);
    return { pBig: round(pBig), mult: mag == null ? null : round(Math.max(0, Math.expm1(mag)), 2), pUp: round(pUp), pRates: round(pRates), pStock: round(pStock), adj: round(adjFrom(pBig, H.big.pos, model.active ? model.strength : 0), 2), ok: model.ok || {}, why: contrib };
  }
  return { VERSION, featurize, tokens, lexicon, buildDataset, train, predict, auc, spearman, adjFrom };
});
