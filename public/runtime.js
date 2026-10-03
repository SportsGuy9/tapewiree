/* Tapewire standalone runtime: provides window.claude.use("db" | "mcp" | "sample") on top of the local
   server, with the same call shapes the claude.ai artifact runtime gives the page. */
(() => {
  "use strict";
  const TW = window.__TW || null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const err = (code, message, extra) => Object.assign({ code, message }, extra || {});

  /* ------------------------------------------------------------------ db */
  async function api(body) {
    let r;
    try { r = await fetch("/api/db", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
    catch (e) { throw err("unavailable", "The Tapewire server isn't reachable. Is `npm start` still running?"); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw err(j.code || "unavailable", j.message || `HTTP ${r.status}`);
    return j;
  }
  const SEG = /^[A-Za-z0-9_\-.~:@+]+$/;
  function check(path, kind) {
    const s = String(path).split("/");
    if (!path || s.some((x) => !SEG.test(x) || x === "." || x === "..")) throw new TypeError(`Invalid path "${path}"`);
    if (kind === "doc" && s.length % 2) throw new TypeError(`Document path needs an even number of segments (${s.length}): ${path}`);
    if (kind === "col" && !(s.length % 2)) throw new TypeError(`Collection path needs an odd number of segments (${s.length}): ${path}`);
  }
  const META = Object.freeze({ fromCache: false, hasPendingWrites: false });
  const docSnap = (id, exists, data) => ({ id, exists, data: () => (exists ? data : undefined), metadata: META });
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

  const subs = new Set();
  let es = null;
  function ensureEvents() {
    if (es || typeof EventSource === "undefined") return;
    es = new EventSource("/api/db/events");
    es.addEventListener("change", (ev) => {
      let paths = []; try { paths = JSON.parse(ev.data).paths || []; } catch (e) { return; }
      for (const s of subs) if (paths.some((p) => s.matches(p))) s.schedule();
    });
    es.onerror = () => { /* EventSource reconnects by itself; the poll below covers the gap */ };
  }
  setInterval(() => { for (const s of subs) s.schedule(); }, 30000);

  function subscribe(matches, fetcher, next, error) {
    let timer = 0, alive = true, sig = null, prevDocs = null, running = false, again = false;
    const s = {
      matches,
      schedule() { if (!alive) return; clearTimeout(timer); timer = setTimeout(run, 120); }
    };
    async function run() {
      if (!alive) return; if (running) { again = true; return; } running = true;
      try {
        const out = await fetcher(prevDocs);
        if (alive && out.sig !== sig) { sig = out.sig; prevDocs = out.docs || null; try { next(out.snap); } catch (e) { console.error(e); } }
      } catch (e) {
        if (e && e.code === "invalid_argument") { alive = false; subs.delete(s); if (error) error(e); else console.error(e); }
      } finally { running = false; if (again) { again = false; s.schedule(); } }
    }
    subs.add(s); ensureEvents(); run();
    return () => { alive = false; clearTimeout(timer); subs.delete(s); };
  }

  function docRef(path) {
    check(path, "doc");
    const id = path.slice(path.lastIndexOf("/") + 1);
    return {
      id, path,
      async get() { const r = await api({ op: "get", path }); return docSnap(id, !!r.exists, r.data); },
      async set(data) { await api({ op: "set", path, data }); },
      async update(data) { await api({ op: "update", path, data }); },
      async delete() { await api({ op: "delete", path }); },
      async acquire(o) { return api({ op: "acquire", path, ...(o || {}) }); },
      onSnapshot(next, error) {
        return subscribe((p) => p === path, async () => { const r = await api({ op: "get", path }); return { sig: r.exists ? "v" + r.v : "none", snap: docSnap(id, !!r.exists, r.data) }; }, next, error);
      },
      collection(sub) { return colRef(path + "/" + sub); }
    };
  }
  function query(col, spec) {
    const q = {
      where(field, op, value) { return query(col, { ...spec, where: [...spec.where, [field, op, value]] }); },
      orderBy(field, dir = "asc") { return query(col, { ...spec, orderBy: [field, dir] }); },
      limit(n) { return query(col, { ...spec, limit: n }); },
      async get() { const r = await api({ op: "query", col, ...spec }); return qSnap(r.docs, null); },
      onSnapshot(next, error) {
        return subscribe((p) => p.slice(0, p.lastIndexOf("/")) === col, async (prev) => {
          const r = await api({ op: "query", col, ...spec });
          return { sig: r.docs.map((d) => d.id + ":" + d.v).join("|"), snap: qSnap(r.docs, prev), docs: r.docs };
        }, next, error);
      }
    };
    return q;
  }
  function qSnap(rows, prev) {
    const docs = rows.map((d) => docSnap(d.id, true, d.data));
    return {
      docs, size: docs.length, empty: !docs.length, metadata: META,
      docChanges() {
        const before = new Map((prev || []).map((d, i) => [d.id, i])); const out = [];
        docs.forEach((d, i) => { const o = before.get(d.id); out.push({ type: o == null ? "added" : "modified", doc: d, oldIndex: o ?? -1, newIndex: i }); });
        const now = new Set(rows.map((d) => d.id));
        (prev || []).forEach((d, i) => { if (!now.has(d.id)) out.push({ type: "removed", doc: docSnap(d.id, true, d.data), oldIndex: i, newIndex: -1 }); });
        return out;
      }
    };
  }
  function colRef(path) {
    check(path, "col");
    return Object.assign(query(path, { where: [], orderBy: null, limit: null }), {
      path,
      doc(id) { return docRef(path + "/" + (id || newId())); },
      async add(data) { const ref = docRef(path + "/" + newId()); await ref.set(data); return ref; }
    });
  }
  const db = Object.freeze({ doc: docRef, collection: colRef });

  /* ------------------------------------------------------------------ mcp (connectors) */
  async function callTool(server, tool, input) {
    let r;
    try { r = await fetch("/api/mcp/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ server, tool, input: input || {} }) }); }
    catch (e) { throw err("server_unavailable", "The Tapewire server isn't reachable.", { retryable: true }); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw err(j.code || "tool_error", j.message || `HTTP ${r.status}`, { retryable: !!j.retryable, retryAfterMs: j.retryAfterMs || 0 });
    return { payload: j.payload, content: [{ type: "text", text: typeof j.payload === "string" ? j.payload : JSON.stringify(j.payload) }] };
  }
  const mcp = Object.freeze({
    callTool,
    async server(name) { return new Proxy({}, { get: (_, tool) => (input) => callTool(name, tool, input).then((r) => r.payload) }); },
    watchTool(server, tool, input, handler, opts) {
      let stop = false;
      const tick = async () => { if (stop) return; try { const r = await callTool(server, tool, input); handler({ type: "data", payload: r.payload, cache: { storedAt: Date.now() } }); } catch (e) { handler({ type: "error", error: e }); } if (opts && opts.refetchInterval && !stop) setTimeout(tick, opts.refetchInterval); };
      tick(); return () => { stop = true; };
    },
    async describeTool() { throw err("capability_removed", "describeTool isn't available in the standalone app"); }
  });

  /* ------------------------------------------------------------------ sample (Claude) */
  async function turn(body, signal, onDelta) {
    let r;
    try { r = await fetch("/api/ai/turn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal }); }
    catch (e) { throw e && e.name === "AbortError" ? err("cancelled", "Stopped.") : err("upstream_error", "The Tapewire server isn't reachable."); }
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "", done = null, failure = null;
    try {
      for (;;) {
        const { value, done: end } = await reader.read(); if (end) break;
        buf += dec.decode(value, { stream: true });
        let k;
        while ((k = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, k); buf = buf.slice(k + 2);
          let ev = "message", data = "";
          for (const line of block.split("\n")) { if (line.startsWith("event:")) ev = line.slice(6).trim(); else if (line.startsWith("data:")) data += line.slice(5).trim(); }
          if (!data) continue; const j = JSON.parse(data);
          if (ev === "text") onDelta(j.delta); else if (ev === "done") done = j; else if (ev === "error") failure = j;
        }
      }
    } catch (e) { if (e && e.name === "AbortError") throw err("cancelled", "Stopped."); throw err("upstream_error", "The answer was interrupted."); }
    if (failure) throw err(failure.code || "upstream_error", failure.message || "AI error");
    if (!done) throw err("upstream_error", "The answer was interrupted.");
    return done;
  }
  const toTurns = (input) => (Array.isArray(input) ? input.map((t) => ({ role: t.role === "assistant" ? "assistant" : "user", content: t.content })) : [{ role: "user", content: String(input) }]);
  async function sample(input, opts = {}) {
    const messages = toTurns(input);
    const tools = Array.isArray(opts.tools) ? opts.tools : [];
    const defs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema || { type: "object", properties: {} } }));
    let text = "", stop = null;
    for (let round = 0; round < 10; round++) {
      text = "";
      const res = await turn({ messages, tools: defs, tier: opts.modelTier || "default", maxTokens: opts.maxTokens }, opts.signal, (delta) => {
        text += delta; if (opts.onText) { try { opts.onText({ text, delta }); } catch (e) { console.error(e); } }
      }).catch((e) => { throw Object.assign(e, { text }); });
      stop = res.stop_reason;
      text = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      if (stop === "refusal") throw err("refused", "Claude declined this request.", { text });
      const uses = (res.content || []).filter((b) => b.type === "tool_use");
      if (!uses.length || stop === "max_tokens") break;
      messages.push({ role: "assistant", content: res.content });
      const results = await Promise.all(uses.map(async (u) => {
        const t = tools.find((x) => x.name === u.name);
        try {
          if (!t) throw new Error(`unknown tool ${u.name}`);
          const out = await t.execute(u.input || {}, { signal: opts.signal });
          return { type: "tool_result", tool_use_id: u.id, content: typeof out === "string" ? out : JSON.stringify(out ?? null) };
        } catch (e) { return { type: "tool_result", tool_use_id: u.id, is_error: true, content: String(e && e.message || e) }; }
      }));
      messages.push({ role: "user", content: results });
    }
    if (!text.trim()) throw err("empty_completion", "Claude returned nothing.");
    return { text, truncated: stop === "max_tokens" };
  }
  function parseJson(text) {
    let t = String(text || "").trim();
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t); if (fence && /^[{[]/.test(fence[1].trim())) t = fence[1].trim();
    try { return JSON.parse(t); } catch (e) { /* look for the outermost object */ }
    const a = t.search(/[{[]/), b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { /* fall through */ } }
    throw err("invalid_json", "The answer came back in the wrong shape.", { text });
  }
  sample.json = async (input, opts = {}) => {
    const res = await sample(input, opts);
    return parseJson(res.text);
  };
  sample.limits = async () => ({ tools: { maxCount: 64 }, images: false, maxPromptBytes: TW && TW.promptBudget || 60000 });

  /* ------------------------------------------------------------------ claude.use */
  const caps = TW ? { db, mcp, sample: TW.ai ? sample : null } : {};
  window.claude = Object.freeze({ use: async (name) => { await sleep(0); return caps[name] || null; } });
})();
