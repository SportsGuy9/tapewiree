/* Tapewire market model: the desk's learned understanding of the market as a whole.

   One model over every instrument the desk prices (index futures, VIX, yields, the dollar and FX, commodities,
   crypto, ETFs and the stocks it watches), sampled hourly from the stored market snapshots. For each instrument
   and hour it combines:
     price action & indicators  momentum over 1h / 4h / 1d / 5d (in units of the instrument's own volatility),
                                distance from the 20h and 100h EMAs and their trend, RSI(14), Bollinger %b, volatility regime
     levels                     prior-day high / low and today's open (in volatility units), breaks of them, position in today's range
     cross-asset context        Nasdaq, VIX, 10-year yield and dollar momentum, VIX level
     news & sentiment           headlines mentioning it (count, tone, importance), the news model's pressure and lean on it,
                                data surprises
     fundamentals               market-cap tier and sector for stocks
     time                       ET hour, weekday
   with interactions per asset class and per instrument, so it can learn "momentum persists in crypto" next to
   "stretched RSI mean-reverts in index futures".

   Targets: forward return over 1h, 4h and 1d divided by the instrument's volatility (z), as direction (logistic)
   and expected z (linear). Validation is walk-forward with a purge gap equal to the horizon; per asset class and
   horizon it reports information coefficient (rank correlation of predicted vs realised), direction accuracy and a
   cost-adjusted backtest of trading the signal, and only (class, horizon) cells that pass are "trusted".
   Family importance is measured by switching each family off on unseen data.

   A second, small model learns from the desk's own closed ideas (p(win) from setup, horizon, asset class, confidence
   and whether the market model and news agreed at entry).

   Browser global TWMarketModel, Node module, and Web Worker (postMessage({input}) -> {ok, res}). */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api; else root.TWMarketModel = api;
  if (typeof importScripts === "function" && typeof postMessage === "function") root.onmessage = (ev) => {
    try { if (!root.TWNewsModel && ev.data.input?.newsModel) { try { importScripts("/newsmodel.js"); } catch (e) {} } postMessage({ ok: true, res: api.train(ev.data.input, ev.data.opt || {}) }); }
    catch (e) { postMessage({ ok: false, error: String((e && e.message) || e) }); }
  };
})(typeof self !== "undefined" ? self : this, function (root) {
  "use strict";
  const VERSION = 1, HOUR = 36e5, DAYMS = 864e5, DIM = 1 << 18, HZ = [1, 4, 24];
  const round = (v, d = 3) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sigmoid = (z) => 1 / (1 + Math.exp(-clamp(z, -30, 30)));
  function fnv(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
  const hidx = (n) => fnv(n) % DIM;

  /* ---------------------------------------------------------------- universe */
  const CLASS = { NQ: "index", ES: "index", RTY: "index", YM: "index", NDX: "index", SPX: "index", RUT: "index", DJI: "index", VIX: "vol", VIX9D: "vol", VIX3M: "vol", VVIX: "vol", MOVE: "vol", SKEW: "vol",
    US10Y: "rates", US2Y: "rates", US5Y: "rates", US3M: "rates", TLT: "rates", DXY: "fx", EURUSD: "fx", USDJPY: "fx", GBPUSD: "fx", AUDUSD: "fx", USDCAD: "fx", USDCHF: "fx", NZDUSD: "fx", USDCNH: "fx", USDMXN: "fx", EURJPY: "fx", GBPJPY: "fx",
    WTI: "commodity", GOLD: "commodity", SILVER: "commodity", COPPER: "commodity", NATGAS: "commodity", BTC: "crypto", ETH: "crypto", SOL: "crypto", QQQ: "etf", SPY: "etf", IWM: "etf", SMH: "etf", SOX: "etf", RSP: "etf", HYG: "credit", KRE: "etf" };
  const classOf = (k) => CLASS[k] || (/^[A-Z]{6}$/.test(k) ? "fx" : "stock");
  const isYield = (k) => /^US\d/.test(k);
  const SKIP = new Set(["US3M", "SKEW", "VIX9D", "VIX3M", "VVIX", "MOVE", "NDX", "SPX", "RUT", "DJI", "SOX"]); // gauges / duplicates: context, not targets
  const ret = (k, a, b) => (isYield(k) ? (b - a) * 100 : Math.log(b / a) * 100); // bp for yields, log-% otherwise

  /* ---------------------------------------------------------------- ET calendar */
  let fmt = null; try { fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" }); } catch (e) {}
  const etCache = new Map();
  function et(t) {
    const hk = Math.floor(t / HOUR); const c = etCache.get(hk); if (c) return c;
    let v; if (fmt) { const p = Object.fromEntries(fmt.formatToParts(new Date(hk * HOUR)).map((x) => [x.type, x.value])); v = { day: `${p.year}-${p.month}-${p.day}`, h: +p.hour % 24, wd: p.weekday }; }
    else { const d = new Date(hk * HOUR - 4 * HOUR); v = { day: d.toISOString().slice(0, 10), h: d.getUTCHours(), wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()] }; }
    if (etCache.size > 50000) etCache.clear(); etCache.set(hk, v); return v;
  }

  /* ---------------------------------------------------------------- hourly series from snapshots */
  // snaps: [{t, q:{k:[p,...]}, stk:{T:[p,...]}, u:[keys refreshed]}] sorted by t. Returns {k: {h: Int32 hour numbers, p: prices}}
  function buildSeries(snaps, opt = {}) {
    const acc = {}; const last = opt.until || Infinity;
    for (const s of snaps) {
      if (s.t > last) break; const hr = Math.floor(s.t / HOUR); const u = s.u ? new Set(s.u) : null;
      const put = (k, v, key) => { if (!v || !Number.isFinite(v[0]) || v[0] === 0 || (u && !u.has(key)) || SKIP.has(k)) return; const a = (acc[k] ||= { h: [], p: [], t: [] }); const n = a.h.length; if (n && a.h[n - 1] === hr) { a.p[n - 1] = v[0]; a.t[n - 1] = s.t; } else { a.h.push(hr); a.p.push(v[0]); a.t.push(s.t); } };
      for (const k in s.q || {}) put(k, s.q[k], k);
      for (const k in s.stk || {}) if (!s.q?.[k]) put(k, s.stk[k], "s:" + k);
    }
    const out = {};
    for (const [k, a] of Object.entries(acc)) if (a.h.length >= (opt.minPts ?? 30)) out[k] = prep(k, a);
    return out;
  }
  // per-series indicators, computed once
  function prep(k, a) {
    const n = a.h.length; const r1 = new Float64Array(n).fill(NaN); const sig = new Float64Array(n).fill(NaN);
    const e20 = new Float64Array(n), e100 = new Float64Array(n), rsi = new Float64Array(n).fill(NaN), bb = new Float64Array(n).fill(NaN), vr = new Float64Array(n).fill(NaN);
    const idx = new Map(); a.h.forEach((h, i) => idx.set(h, i));
    let ag = 0, al = 0, ra = 0;
    for (let i = 0; i < n; i++) {
      const p = a.p[i]; e20[i] = i ? e20[i - 1] + (2 / 21) * (p - e20[i - 1]) : p; e100[i] = i ? e100[i - 1] + (2 / 101) * (p - e100[i - 1]) : p;
      if (i && a.h[i] - a.h[i - 1] <= 3) { r1[i] = ret(k, a.p[i - 1], p) / Math.sqrt(a.h[i] - a.h[i - 1]); const g = Math.max(0, r1[i]), l = Math.max(0, -r1[i]); if (ra < 14) { ag += g / 14; al += l / 14; ra++; } else { ag = (ag * 13 + g) / 14; al = (al * 13 + l) / 14; } if (ra >= 14) rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
      // volatility: median |hourly return| over the trailing 120 points (needs 24) / 0.674 -> sigma
      if (i >= 24) { const w = []; for (let j = Math.max(1, i - 120); j <= i; j++) if (Number.isFinite(r1[j])) w.push(Math.abs(r1[j])); if (w.length >= 20) { w.sort((x, y) => x - y); sig[i] = Math.max(w[w.length >> 1] / 0.674, isYield(k) ? 0.3 : 0.02); const s24 = []; for (let j = Math.max(1, i - 24); j <= i; j++) if (Number.isFinite(r1[j])) s24.push(Math.abs(r1[j])); s24.sort((x, y) => x - y); vr[i] = s24.length >= 8 ? s24[s24.length >> 1] / 0.674 / sig[i] : NaN; } }
      if (i >= 19) { let m = 0; for (let j = i - 19; j <= i; j++) m += a.p[j]; m /= 20; let v = 0; for (let j = i - 19; j <= i; j++) v += (a.p[j] - m) ** 2; const sd = Math.sqrt(v / 20); bb[i] = sd ? (p - m) / (2 * sd) : 0; }
    }
    // ET-day levels: prior day high/low, today's open, today's running high/low
    const day = a.h.map((h) => et(h * HOUR).day); const lv = []; let cur = null, prev = null;
    for (let i = 0; i < n; i++) {
      if (!cur || cur.day !== day[i]) { prev = cur && cur.n >= 3 ? cur : prev; cur = { day: day[i], o: a.p[i], hi: a.p[i], lo: a.p[i], n: 0 }; }
      cur.hi = Math.max(cur.hi, a.p[i]); cur.lo = Math.min(cur.lo, a.p[i]); cur.n++;
      lv.push({ o: cur.o, hi: cur.hi, lo: cur.lo, n: cur.n, ph: prev?.hi ?? null, pl: prev?.lo ?? null });
    }
    return { k, cls: classOf(k), h: a.h, p: a.p, t: a.t, idx, r1, sig, e20, e100, rsi, bb, vr, lv };
  }
  // price `back` hours before index i (nearest point within 2h), or null
  function back(S, i, n) { const target = S.h[i] - n; for (let d = 0; d <= 2; d++) { const j = S.idx.get(target - d) ?? S.idx.get(target + d); if (j != null && j < i) return S.p[j]; } return null; }
  function fwd(S, i, n) { const target = S.h[i] + n; for (let d = 0; d <= 1; d++) { const j = S.idx.get(target + d) ?? S.idx.get(target - d); if (j != null && j > i) return S.p[j]; } return null; }

  /* ---------------------------------------------------------------- features */
  const zb = (z) => (z == null ? null : z <= -2 ? "vdn" : z <= -1 ? "dn" : z <= -0.3 ? "sdn" : z < 0.3 ? "flat" : z < 1 ? "sup" : z < 2 ? "up" : "vup");
  const FAMILY = { m: "price", ema: "price", trend: "price", rsi: "price", bb: "price", vr: "price", lvl: "levels", rng: "levels", ctx: "context", vix: "context", news: "news", np: "news", tone: "news", cal: "news", mcap: "fundamentals", sector: "fundamentals", hr: "time", dow: "time", A: "identity", AC: "identity" };
  const famOf = (name) => { const base = name.includes("|") ? name.slice(name.indexOf("|") + 1) : name; const pre = base.split(/[=_]/)[0].replace(/\d+$/, ""); return FAMILY[pre] || "identity"; };
  // context: market-wide state at hour h, from the series of the bellwethers
  function contextAt(SER, hr) {
    const out = [];
    const z = (k, n) => { const S = SER[k]; if (!S) return null; let i = S.idx.get(hr) ?? S.idx.get(hr - 1); if (i == null) return null; const b = back(S, i, n); const s = S.sig[i]; return b == null || !Number.isFinite(s) ? null : ret(k, b, S.p[i]) / (s * Math.sqrt(n)); };
    for (const [k, nm] of [["NQ", "nq"], ["VIX", "vixchg"], ["US10Y", "y10"], ["DXY", "usd"], ["BTC", "btc"]]) { const v = z(k, 4); if (v != null) out.push([`ctx_${nm}4=${zb(v)}`, 1]); const d = z(k, 24); if (d != null && k !== "BTC") out.push([`ctx_${nm}24=${zb(d)}`, 1]); }
    const V = SER.VIX; if (V) { const i = V.idx.get(hr) ?? V.idx.get(hr - 1); if (i != null) { const v = V.p[i]; out.push([`vix=${v < 14 ? "low" : v < 18 ? "calm" : v < 24 ? "elevated" : v < 32 ? "high" : "panic"}`, 1]); } }
    return out;
  }
  // news state for instrument k over (t-3h, t]: mentions, tone, importance, news-model pressure and lean, data surprises
  function newsAt(NEWS, k, t) {
    if (!NEWS) return [];
    const evs = NEWS.byHour; const h0 = Math.floor(t / HOUR); let n = 0, sent = 0, imp = 0, pw = 0, pl = 0, cal = 0;
    for (let h = h0 - 2; h <= h0; h++) for (const e of evs.get(h) || []) {
      if (e.t > t) continue; const age = (t - e.t) / HOUR; if (age > 3) continue;
      if (e.m?.has(k)) { n++; if (Number.isFinite(e.sent)) sent += e.sent; imp = Math.max(imp, e.imp || 0); }
      const pa = e.pa?.[k]; if (pa) { const w = pa[0] * Math.exp(-age / 1.5); pw += w; if (pa[1] != null) pl += w * (pa[1] - 0.5) * 2; }
      if (e.cal != null && e.m?.has(k)) cal += e.cal;
    }
    const out = [[`news_n=${n === 0 ? "0" : n === 1 ? "1" : n <= 3 ? "2-3" : "4+"}`, 1]];
    if (n) { out.push([`news_imp=${imp >= 7 ? "high" : imp >= 5.5 ? "mid" : "low"}`, 1]); const s = sent / n; if (Math.abs(s) >= 0.1) out.push([`tone=${s > 0 ? "pos" : "neg"}`, 1]); }
    if (pw >= 0.3) { out.push([`np=${pw >= 1.5 ? "high" : "some"}`, 1]); const lean = pl / pw; if (Math.abs(lean) >= 0.2) out.push(["np_lean", clamp(lean * Math.min(pw, 2) / 2, -1, 1)], [`np_dir=${lean > 0 ? "up" : "down"}`, 1]); }
    if (cal) out.push([`cal=${cal > 0 ? "better" : "worse"}`, 1]);
    return out;
  }
  function featuresAt(S, i, ctx, news, fund) {
    const F = []; const p = S.p[i]; const s = S.sig[i]; if (!Number.isFinite(s)) return null;
    const mom = (n) => { const b = back(S, i, n); return b == null ? null : ret(S.k, b, p) / (s * Math.sqrt(n)); };
    for (const n of [1, 4, 24, 120]) { const z = mom(n); if (z == null) continue; F.push([`m${n}=${zb(z)}`, 1], [`m${n}`, clamp(z, -3, 3) / 3]); }
    const d20 = ret(S.k, S.e20[i], p) / (s * Math.sqrt(10)), d100 = ret(S.k, S.e100[i], p) / (s * Math.sqrt(50)); const tr = ret(S.k, S.e100[i], S.e20[i]) / (s * Math.sqrt(30));
    if (i >= 30) F.push([`ema20=${zb(d20)}`, 1], [`ema100=${zb(d100)}`, 1], [`trend=${tr > 0.5 ? "up" : tr < -0.5 ? "down" : "flat"}`, 1]);
    if (Number.isFinite(S.rsi[i])) { const r = S.rsi[i]; F.push([`rsi=${r < 25 ? "<25" : r < 35 ? "25-35" : r < 45 ? "35-45" : r <= 55 ? "45-55" : r <= 65 ? "55-65" : r <= 75 ? "65-75" : ">75"}`, 1]); }
    if (Number.isFinite(S.bb[i])) { const b = S.bb[i]; F.push([`bb=${b < -1 ? "below" : b < -0.5 ? "low" : b <= 0.5 ? "mid" : b <= 1 ? "high" : "above"}`, 1]); }
    if (Number.isFinite(S.vr[i])) { const v = S.vr[i]; F.push([`vr=${v < 0.7 ? "quiet" : v < 1.4 ? "normal" : "hot"}`, 1]); }
    const L = S.lv[i]; const sd = s * Math.sqrt(6);
    if (L.ph != null) { const dh = ret(S.k, L.ph, p) / sd, dl = ret(S.k, L.pl, p) / sd; F.push([`lvl_ph=${dh > 0.3 ? "above" : dh > -0.5 ? "at" : "below"}`, 1], [`lvl_pl=${dl < -0.3 ? "below" : dl < 0.5 ? "at" : "above"}`, 1]); }
    if (L.n >= 2) { const dop = ret(S.k, L.o, p) / sd; F.push([`lvl_open=${zb(dop)}`, 1]); }
    if (L.n >= 3 && L.hi > L.lo) { const pos = (p - L.lo) / (L.hi - L.lo); F.push([`rng=${pos < 0.2 ? "low" : pos > 0.8 ? "high" : "mid"}`, 1]); }
    for (const c of ctx || []) F.push(c);
    for (const c of news || []) F.push(c);
    const fu = fund?.[S.k]; if (fu) { if (fu.mcap) F.push([`mcap=${fu.mcap >= 200 ? "mega" : fu.mcap >= 10 ? "large" : fu.mcap >= 2 ? "mid" : "small"}`, 1]); if (fu.sector) F.push([`sector=${String(fu.sector).slice(0, 24)}`, 1]); }
    const e = et(S.t[i]); F.push([`hr=${e.h < 4 ? "asia" : e.h < 9 ? "europe" : e.h < 11 ? "us_open" : e.h < 15 ? "us_mid" : e.h < 17 ? "us_close" : "evening"}`, 1], [`dow=${e.wd}`, 1]);
    // interactions: everything per asset class; price, levels and news per instrument (non-stocks)
    const out = [["bias", 1], [`A=${S.k}`, 1], [`AC=${S.cls}`, 1]];
    for (const [nm, v] of F) { out.push([nm, v * 0.5], [`AC=${S.cls}|${nm}`, v]); if (S.cls !== "stock" && /^(m\d|ema|trend|rsi|bb|lvl|rng|np|news|tone)/.test(nm)) out.push([`A=${S.k}|${nm}`, v]); }
    return out;
  }

  /* ---------------------------------------------------------------- news index */
  // events: [{t, title, tk, imp, sent, cal:{better}, pa:[[k,p,up]]}]. Mentions by ticker or by the news model's asset words.
  function newsIndex(events, keys, newsModel) {
    if (!events?.length) return null;
    const NM = root.TWNewsModel || (typeof require === "function" ? (() => { try { return require("./newsmodel.js"); } catch (e) { return null; } })() : null);
    const words = NM?.ASSETS || {}; const byHour = new Map(); let scored = 0;
    for (const e of events) {
      if (!e?.t || !e.title || e.src === "mkt" || e.src === "halt") continue;
      const lo = String(e.title).toLowerCase(); const m = new Set();
      for (const t of e.tk || []) m.add(t === "NDX" ? "NQ" : t === "SPX" ? "ES" : t);
      for (const k of keys) if (words[k]?.[1]?.test(lo)) m.add(k);
      let pa = null;
      if (Array.isArray(e.pa)) pa = Object.fromEntries(e.pa.map((x) => [x[0], [x[1], x[2]]]));
      else if (newsModel?.heads?.xa && NM && (e.imp || 0) >= 5 && scored < 8000) { try { const r = NM.predict(newsModel, { t: e.t, title: e.title, cls: e.cls || "general", outlet: e.outlet || "", tk: e.tk || [], sent: e.sent, ri: e.imp }, { assets: true, top: 6 }); pa = Object.fromEntries((r?.assets || []).filter((a) => a.lift >= 1.3).map((a) => [a.k, [a.p * Math.min(3, a.lift) / 3, a.up]])); scored++; } catch (err) {} }
      const x = { t: e.t, m, sent: e.sent, imp: e.imp, pa, cal: e.cal?.better == null ? null : e.cal.better ? 1 : -1 };
      const h = Math.floor(e.t / HOUR); if (!byHour.has(h)) byHour.set(h, []); byHour.get(h).push(x);
    }
    return { byHour };
  }

  /* ---------------------------------------------------------------- learner */
  function trainHead(rows, key, kind, opt = {}) {
    const use = rows.filter((x) => x[key] != null); if (use.length < 100) return null;
    const w = new Float32Array(DIM), g2 = new Float32Array(DIM).fill(1e-6); const lr = kind === "linear" ? 0.03 : 0.08, l2 = opt.l2 ?? 3e-4;
    const newest = use[use.length - 1].t, half = opt.half ?? 25 * DAYMS; let seed = 11; const order = use.map((_, i) => i);
    let mean = 0; if (kind === "linear") { for (const x of use) mean += x[key]; mean /= use.length; }
    for (let ep = 0; ep < (opt.epochs ?? 3); ep++) {
      for (let i = order.length - 1; i > 0; i--) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; const j = seed % (i + 1); [order[i], order[j]] = [order[j], order[i]]; }
      for (const k of order) {
        const x = use[k]; const sw = Math.pow(0.5, (newest - x.t) / half); let z = kind === "linear" ? mean : 0; for (const [i, v] of x.h) z += w[i] * v;
        const err = ((kind === "linear" ? z : sigmoid(z)) - x[key]) * sw;
        for (const [i, v] of x.h) { const g = err * v + l2 * w[i]; g2[i] += g * g; w[i] -= (lr * g) / Math.sqrt(g2[i]); }
      }
    }
    return { kind, w, mean, n: use.length };
  }
  const score = (H, h, skip) => { if (!H) return null; let z = H.kind === "linear" ? H.mean : 0; for (const [i, v, f] of h) if (!skip || f !== skip) z += H.w[i] * v; return H.kind === "linear" ? z : sigmoid(z); };
  function auc(p, y) { const a = p.map((v, i) => [v, y[i]]).sort((x, z) => x[0] - z[0]); let r = 0, np = 0, nn = 0; a.forEach((x, i) => { if (x[1]) { r += i + 1; np++; } else nn++; }); return np && nn ? (r - (np * (np + 1)) / 2) / (np * nn) : null; }
  function spearman(a, b) { if (a.length < 10) return null; const rk = (v) => { const o = v.map((x, i) => [x, i]).sort((x, y) => x[0] - y[0]); const r = new Array(v.length); o.forEach((x, i) => { r[x[1]] = i; }); return r; }; const ra = rk(a), rb = rk(b); const n = a.length, m = (n - 1) / 2; let c = 0, va = 0, vb = 0; for (let i = 0; i < n; i++) { c += (ra[i] - m) * (rb[i] - m); va += (ra[i] - m) ** 2; vb += (rb[i] - m) ** 2; } return va && vb ? c / Math.sqrt(va * vb) : null; }
  const COST = { 1: 0.08, 4: 0.05, 24: 0.03 }; // round-trip cost in units of the horizon's volatility

  /* ---------------------------------------------------------------- dataset */
  function buildRows(SER, NEWS, fund, opt = {}) {
    const rows = []; const stride = opt.stride ?? 2; const ctxMemo = new Map();
    for (const S of Object.values(SER)) {
      for (let i = 30; i < S.h.length; i += stride) {
        if (!Number.isFinite(S.sig[i])) continue;
        const hr = S.h[i]; let ctx = ctxMemo.get(hr); if (!ctx) { ctx = contextAt(SER, hr); ctxMemo.set(hr, ctx); }
        const f = featuresAt(S, i, ctx, newsAt(NEWS, S.k, S.t[i]), fund); if (!f) continue;
        const row = { k: S.k, cls: S.cls, t: S.t[i], h: f.map(([nm, v]) => [hidx(nm), v, famOf(nm)]) };
        for (const H of HZ) { const b = fwd(S, i, H); if (b == null) continue; const z = ret(S.k, S.p[i], b) / (S.sig[i] * Math.sqrt(H)); row["z" + H] = clamp(z, -4, 4); row["u" + H] = z >= 0.2 ? 1 : z <= -0.2 ? 0 : null; }
        if (row.z1 != null || row.z4 != null || row.z24 != null) rows.push(row);
      }
    }
    return rows.sort((a, b) => a.t - b.t);
  }
  function trainHeads(rows, opt) { const H = {}; for (const h of HZ) { H["d" + h] = trainHead(rows, "u" + h, "logit", opt); H["r" + h] = trainHead(rows, "z" + h, "linear", opt); } return H; }

  /* ---------------------------------------------------------------- evaluation */
  function cellStats(list, h, thr = 0.12) {
    const d = list.filter((x) => x.u != null && x.pd != null); const conf = d.filter((x) => Math.abs(x.pd - 0.5) >= 0.04); const upr = d.length ? d.filter((x) => x.u).length / d.length : 0.5;
    const ic = spearman(list.map((x) => x.pr), list.map((x) => x.z));
    const tr = list.filter((x) => Math.abs(x.pr) >= thr).map((x) => Math.sign(x.pr) * x.z - COST[h]);
    const avg = tr.length ? tr.reduce((a, b) => a + b, 0) / tr.length : null; const sd = tr.length > 1 ? Math.sqrt(tr.reduce((a, b) => a + (b - avg) ** 2, 0) / (tr.length - 1)) : null;
    return { n: list.length, ic: round(ic), auc: d.length >= 30 ? round(auc(d.map((x) => x.pd), d.map((x) => x.u))) : null, dirN: conf.length, dirAcc: conf.length >= 20 ? round(conf.filter((x) => (x.pd >= 0.5 ? 1 : 0) === x.u).length / conf.length) : null, dirBase: round(Math.max(upr, 1 - upr)), trades: tr.length, avg: round(avg), hit: tr.length ? round(tr.filter((v) => v > 0).length / tr.length) : null, t: avg != null && sd ? round(avg / (sd / Math.sqrt(tr.length)), 2) : null };
  }
  // conviction threshold per horizon: the 70th percentile of |forecast| on (recent) training rows, so the backtest trades the desk's stronger calls
  function thresholds(H, train) { const out = {}; const smp = train.slice(-3000); for (const h of HZ) { const v = smp.map((x) => Math.abs(score(H["r" + h], x.h) ?? 0)).sort((a, b) => a - b); out[h] = v.length ? Math.max(0.05, v[Math.floor(v.length * 0.7)]) : 0.12; } return out; }
  function evaluate(H, test, families, thr = {}) {
    const out = {}; const imp = {};
    for (const h of HZ) {
      const P = []; for (const x of test) { if (x["z" + h] == null) continue; P.push({ cls: x.cls, k: x.k, z: x["z" + h], u: x["u" + h], pr: score(H["r" + h], x.h), pd: score(H["d" + h], x.h), x }); }
      if (P.length < 50) continue;
      out[h] = { all: cellStats(P, h, thr[h]), cls: {} };
      for (const c of [...new Set(P.map((p) => p.cls))]) { const q = P.filter((p) => p.cls === c); if (q.length >= 60) out[h].cls[c] = cellStats(q, h, thr[h]); }
      // family importance: IC lost when a family is switched off (per class too)
      if (families) { const base = out[h].all.ic ?? 0; imp[h] = { all: {}, cls: {} };
        for (const fam of families) { const ic = spearman(P.map((p) => score(H["r" + h], p.x.h, fam)), P.map((p) => p.z)); imp[h].all[fam] = round(base - (ic ?? 0)); }
        for (const c of Object.keys(out[h].cls)) { const q = P.filter((p) => p.cls === c); const b = spearman(q.map((p) => p.pr), q.map((p) => p.z)) ?? 0; imp[h].cls[c] = {}; for (const fam of families) imp[h].cls[c][fam] = round(b - (spearman(q.map((p) => score(H["r" + h], p.x.h, fam)), q.map((p) => p.z)) ?? 0)); }
      }
    }
    return { cells: out, imp };
  }
  function mergeFolds(list) {
    // pooled average of per-fold stats, weighted by n
    const out = {};
    for (const h of HZ) {
      const cells = list.map((m) => m.cells[h]).filter(Boolean); if (!cells.length) continue;
      const avg = (arr) => { const o = {}; const keys = Object.keys(arr[0]); const N = arr.reduce((a, s) => a + (s.n || 0), 0); for (const k of keys) { if (["n", "trades", "dirN"].includes(k)) { o[k] = arr.reduce((a, s) => a + (s[k] || 0), 0); continue; } const v = arr.filter((s) => Number.isFinite(s[k])); o[k] = v.length ? round(v.reduce((a, s) => a + s[k] * (s.n || 1), 0) / v.reduce((a, s) => a + (s.n || 1), 0)) : null; } o.n = N; return o; };
      out[h] = { all: avg(cells.map((c) => c.all)), cls: {} };
      const cs = new Set(cells.flatMap((c) => Object.keys(c.cls))); for (const c of cs) { const v = cells.map((x) => x.cls[c]).filter(Boolean); if (v.length) out[h].cls[c] = avg(v); }
    }
    return out;
  }
  const trusted = (s) => !!s && s.n >= 150 && s.trades >= 40 && (s.ic ?? 0) >= 0.03 && (s.avg ?? -1) > 0 && (s.t ?? 0) >= 1.5 && (s.dirAcc == null || s.dirAcc >= (s.dirBase ?? 0.5) - 0.01);

  /* ---------------------------------------------------------------- training */
  function train(input, opt = {}) {
    const SER = buildSeries(input.snaps || [], opt); const keys = Object.keys(SER);
    if (!keys.length) return { status: "warming", n: 0, need: 400, why: "no instrument has 30+ hours of price history yet" };
    const NEWS = newsIndex(input.events, keys, input.newsModel);
    const pts = Object.values(SER).reduce((a, S) => a + S.h.length, 0);
    const rows = buildRows(SER, NEWS, input.fund || {}, { ...opt, stride: opt.stride ?? Math.max(1, Math.round(pts / 60000)) });
    const need = opt.minRows ?? 400; if (rows.length < need) return { status: "warming", n: rows.length, need, instruments: keys.length };
    const span = rows[rows.length - 1].t - rows[0].t; const K = 3; const start = Math.floor(rows.length * 0.5); const folds = [];
    const families = ["price", "levels", "context", "news", "fundamentals", "time"];
    for (let f = 0; f < K; f++) {
      const a = start + Math.floor(((rows.length - start) * f) / K), b = start + Math.floor(((rows.length - start) * (f + 1)) / K);
      const cut = rows[a].t; const tr = rows.filter((x) => x.t < cut - 24 * HOUR); // purge: no training label overlaps the test window
      const te = rows.slice(a, b); if (tr.length < 200 || te.length < 80) continue;
      const Hf = trainHeads(tr, opt); folds.push(evaluate(Hf, te, f === K - 1 ? families : null, thresholds(Hf, tr)));
    }
    const cells = mergeFolds(folds); const imp = folds.find((x) => Object.keys(x.imp || {}).length)?.imp || {};
    const ok = {}; for (const h of HZ) { ok[h] = { all: trusted(cells[h]?.all) }; for (const [c, s] of Object.entries(cells[h]?.cls || {})) ok[h][c] = trusted(s); }
    const H = trainHeads(rows, opt); const thr = thresholds(H, rows);
    // the desk's learned rules: class-level interaction weights of the 4h return head
    const names = new Map(); for (const S of Object.values(SER)) { const i = S.h.length - 1; const f = featuresAt(S, i, contextAt(SER, S.h[i]), [], input.fund || {}); for (const [nm] of f || []) names.set(nm, hidx(nm)); }
    for (const c of new Set(Object.values(SER).map((S) => S.cls))) for (const nm of ["news_n=1", "news_n=2-3", "news_n=4+", "np=some", "np=high", "np_dir=up", "np_dir=down", "tone=pos", "tone=neg", "cal=better", "cal=worse"]) names.set(`AC=${c}|${nm}`, hidx(`AC=${c}|${nm}`));
    const rules = {};
    for (const h of [4, 24]) { const R = H["r" + h]; if (!R) continue; const by = {};
      for (const [nm, i] of names) { const m = /^AC=([^|]+)\|(.+)$/.exec(nm); if (!m || !/=/.test(m[2])) continue; (by[m[1]] ||= []).push([m[2], round(R.w[i], 4), famOf(m[2])]); }
      rules[h] = Object.fromEntries(Object.entries(by).map(([c, arr]) => { arr.sort((a, b) => b[1] - a[1]); const seen = new Set(); const u = (x) => !seen.has(x[0]) && seen.add(x[0]); return [c, { bull: arr.filter((x) => x[1] > 0.01).filter(u).slice(0, 8), bear: arr.slice().reverse().filter((x) => x[1] < -0.01).filter(u).slice(0, 8) }]; })); }
    const sig = Object.fromEntries(Object.values(SER).map((S) => [S.k, round(S.sig[S.h.length - 1], 4)]));
    return { status: "trained", version: VERSION, t: Date.now(), n: rows.length, instruments: keys.length, days: round(span / DAYMS, 1), folds: folds.length, cells, ok, imp, rules, sig, thr: Object.fromEntries(Object.entries(thr).map(([k, v]) => [k, round(v)])), heads: pack(H) };
  }
  function pack(H) { const out = {}; for (const [k, h] of Object.entries(H)) { if (!h) continue; const nz = []; for (let i = 0; i < h.w.length; i++) if (Math.abs(h.w[i]) > 3e-4) nz.push([i, Math.round(h.w[i] * 1e4) / 1e4]); nz.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])); out[k] = { kind: h.kind, mean: round(h.mean, 5), n: h.n, w: nz.slice(0, 15000) }; } return out; }
  const hydrated = new WeakMap();
  function hydrate(M) { if (!M?.heads) return null; let H = hydrated.get(M); if (H) return H; H = {}; for (const [k, h] of Object.entries(M.heads)) { const w = new Float32Array(DIM); for (const [i, v] of h.w) w[i] = v; H[k] = { kind: h.kind, mean: h.mean, w }; } hydrated.set(M, H); return H; }

  /* ---------------------------------------------------------------- live outlook */
  // state: {snaps, events (recent), newsModel, fund}. Returns one outlook per instrument at its latest price.
  function outlook(M, state, opt = {}) {
    const H = hydrate(M); if (!H) return [];
    const SER = buildSeries(state.snaps || [], { minPts: 26 }); const keys = Object.keys(SER); const NEWS = newsIndex(state.events, keys, state.newsModel); const now = opt.now || Date.now();
    const out = [];
    for (const S of Object.values(SER)) {
      const i = S.h.length - 1; if (now - S.t[i] > (opt.maxAge ?? 3 * HOUR) || !Number.isFinite(S.sig[i])) continue;
      const nf = newsAt(NEWS, S.k, now); const F = featuresAt(S, i, contextAt(SER, S.h[i]), nf, state.fund || {}); if (!F) continue;
      const h = F.map(([nm, v]) => [hidx(nm), v, famOf(nm)]);
      const o = { k: S.k, cls: S.cls, p: S.p[i], t: S.t[i], sig: round(S.sig[i], 4), unit: isYield(S.k) ? "bp" : "%", hz: {} };
      for (const hh of HZ) { const pr = score(H["r" + hh], h), pd = score(H["d" + hh], h); if (pr == null) continue; o.hz[hh] = { z: round(pr), p: round(pd), ok: !!(M.ok?.[hh]?.[S.cls] ?? M.ok?.[hh]?.all), strong: Math.abs(pr) >= (M.thr?.[hh] ?? 0.12), move: round(pr * S.sig[i] * Math.sqrt(hh), 3) }; }
      // why: contribution of each family and the strongest single features (4h head)
      const R = H.r4; if (R) { const fam = {}; const top = []; F.forEach(([nm, v], j) => { const c = R.w[h[j][0]] * v; if (!c || nm === "bias") return; fam[h[j][2]] = (fam[h[j][2]] || 0) + c; top.push([nm.replace(/^AC=[^|]+\|/, "").replace(/^A=[^|]+\|/, ""), c]); });
        const agg = {}; for (const [n, c] of top) agg[n] = (agg[n] || 0) + c; o.fam = Object.fromEntries(Object.entries(fam).map(([k, v]) => [k, round(v, 3)])); o.why = Object.entries(agg).filter(([n]) => !/^A(C)?=/.test(n)).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 5).map(([n, c]) => [n, round(c, 3)]); }
      o.feat = F.filter(([nm]) => !nm.includes("|") && !/^A(C)?=|^bias$/.test(nm) && nm.includes("=")).map(([nm]) => nm);
      // composite: agreement-weighted, trusted horizons count double
      let sc = 0, w = 0; for (const [hh, x] of Object.entries(o.hz)) { const ww = (x.ok ? 2 : 1) * ({ 1: 0.6, 4: 1, 24: 0.8 }[hh]); sc += ww * x.z; w += ww; } o.score = round(w ? sc / w : 0);
      const signs = Object.values(o.hz).map((x) => Math.sign(x.z)).filter(Boolean); o.agree = signs.length >= 2 && signs.every((s) => s === signs[0]);
      out.push(o);
    }
    return out.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  }

  /* ---------------------------------------------------------------- learning from the desk's own trades */
  // ideas: [{t, setup, horizon, dir, cls, conf, src, ctx:{mm, np, rg}, r (closed R or null)}]
  function ideaFeatures(x) {
    const f = [["bias", 1], [`setup=${x.setup || "?"}`, 1], [`hz=${x.horizon || "?"}`, 1], [`dir=${x.dir}`, 1], [`cls=${x.cls}`, 1], [`src=${x.src || "?"}`, 1], [`conf=${x.conf >= 70 ? "70+" : x.conf >= 55 ? "55-70" : "<55"}`, 1], [`cls=${x.cls}|dir=${x.dir}`, 1]];
    const mm = x.ctx?.mm; if (mm != null) f.push([`mm=${mm >= 0.15 ? "with" : mm <= -0.15 ? "against" : "neutral"}`, 1], ["mm", clamp(mm, -1, 1)]);
    const np = x.ctx?.np; if (np != null) f.push([`news=${np >= 0.2 ? "with" : np <= -0.2 ? "against" : "neutral"}`, 1]);
    if (x.ctx?.rg?.r) f.push([`risk=${x.ctx.rg.r}`, 1]); if (x.ctx?.rg?.v) f.push([`vol=${x.ctx.rg.v}`, 1]);
    return f;
  }
  function trainIdeas(ideas) {
    const done = ideas.filter((x) => Number.isFinite(x.r)).sort((a, b) => a.t - b.t);
    const by = (fn) => { const m = {}; for (const x of done) { const k = fn(x); if (k == null) continue; const g = (m[k] ||= { n: 0, w: 0, r: 0 }); g.n++; if (x.r > 0) g.w++; g.r += x.r; } return Object.fromEntries(Object.entries(m).map(([k, g]) => [k, { n: g.n, win: round(g.w / g.n), avgR: round(g.r / g.n, 2) }])); };
    const tables = { marketModel: by((x) => (x.ctx?.mm == null ? null : x.ctx.mm >= 0.15 ? "with" : x.ctx.mm <= -0.15 ? "against" : "neutral")), news: by((x) => (x.ctx?.np == null ? null : x.ctx.np >= 0.2 ? "with" : x.ctx.np <= -0.2 ? "against" : "neutral")), cls: by((x) => x.cls), setup: by((x) => x.setup), horizon: by((x) => x.horizon) };
    if (done.length < 40) return { status: "warming", n: done.length, need: 40, tables };
    // logistic p(win) with leave-later-out validation
    const rows = done.map((x) => ({ t: x.t, f: ideaFeatures(x), y: x.r > 0 ? 1 : 0 }));
    const fit = (tr) => { const w = new Map(); for (let ep = 0; ep < 30; ep++) for (const x of tr) { let z = 0; for (const [n, v] of x.f) z += (w.get(n) || 0) * v; const e = sigmoid(z) - x.y; for (const [n, v] of x.f) { const c = w.get(n) || 0; w.set(n, c - 0.05 * (e * v + 0.01 * c)); } } return w; };
    const pr = (w, f) => { let z = 0; for (const [n, v] of f) z += (w.get(n) || 0) * v; return sigmoid(z); };
    const cut = Math.floor(rows.length * 0.7); const w0 = fit(rows.slice(0, cut)); const te = rows.slice(cut);
    const vAuc = te.length >= 12 ? auc(te.map((x) => pr(w0, x.f)), te.map((x) => x.y)) : null;
    const w = fit(rows); const weights = [...w.entries()].filter(([n]) => n !== "bias").sort((a, b) => b[1] - a[1]);
    return { status: "trained", n: done.length, auc: round(vAuc), ok: vAuc != null && vAuc >= 0.58, w: Object.fromEntries([...w.entries()].map(([n, v]) => [n, round(v, 4)])), helps: weights.slice(0, 6).map(([n, v]) => [n, round(v, 3)]), hurts: weights.slice(-6).reverse().map(([n, v]) => [n, round(v, 3)]), tables };
  }
  function ideaWinP(meta, x) { if (!meta?.w) return null; let z = 0; for (const [n, v] of ideaFeatures(x)) z += (meta.w[n] || 0) * v; return round(sigmoid(z)); }

  return { VERSION, HZ, classOf, buildSeries, featuresAt, train, outlook, trainIdeas, ideaWinP, famOf, spearman, auc };
});
