// Stand-in for the claude.ai `sample` capability: one model turn per request, streamed back to the page.
// The page runs the tool loop itself (its tools read page state), so this endpoint only ever does one turn
// and returns the full assistant content (thinking blocks included) for the page to append unchanged.
import Anthropic from "@anthropic-ai/sdk";

export function makeAi(cfg) {
  const A = cfg.anthropic;
  const client = A.apiKey ? new Anthropic({ apiKey: A.apiKey }) : null;
  let fallbacksOk = A.fallbacks;

  const errOf = (e) => {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return { code: "not_granted", message: "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in .env." };
    if (e instanceof Anthropic.RateLimitError) return { code: "rate_limited", message: "Anthropic rate limit reached. Try again shortly." };
    if (e instanceof Anthropic.BadRequestError) return { code: /too long|too many tokens|context/i.test(e.message) ? "prompt_too_large" : "invalid_request", message: e.message };
    if (e instanceof Anthropic.APIUserAbortError) return { code: "cancelled", message: "Stopped." };
    if (e instanceof Anthropic.APIError) return { code: "upstream_error", message: e.message };
    return { code: "upstream_error", message: e?.message || String(e) };
  };

  async function turn(body, send, signal) {
    if (!client) { send("error", { code: "not_granted", message: "AI is off: add ANTHROPIC_API_KEY to the .env file and restart Tapewire." }); return; }
    const tier = ["quick", "default", "complex"].includes(body.tier) ? body.tier : "default";
    const params = {
      model: A.models[tier],
      max_tokens: Math.min(+body.maxTokens || A.maxTokens, 64000),
      messages: body.messages,
      output_config: { effort: A.effort[tier] }
    };
    if (body.system) params.system = body.system;
    if (Array.isArray(body.tools) && body.tools.length) params.tools = body.tools.map((t) => ({ name: t.name, description: t.description || "", input_schema: t.input_schema || { type: "object", properties: {} } }));
    const run = async (withFallback) => {
      const p = withFallback ? { ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : params;
      const stream = withFallback ? client.beta.messages.stream(p) : client.messages.stream(p);
      signal.addEventListener("abort", () => stream.abort(), { once: true });
      stream.on("text", (delta) => send("text", { delta }));
      return stream.finalMessage();
    };
    try {
      let msg;
      try { msg = await run(fallbacksOk); }
      catch (e) {
        // accounts or models without server-side fallback reject the beta: drop it and remember
        if (fallbacksOk && e instanceof Anthropic.BadRequestError && /fallback/i.test(e.message)) { fallbacksOk = false; msg = await run(false); }
        else throw e;
      }
      send("done", { content: msg.content, stop_reason: msg.stop_reason, stop_details: msg.stop_details ?? null, usage: msg.usage, model: msg.model });
    } catch (e) { send("error", errOf(e)); }
  }
  return { turn, enabled: !!client, promptBudget: A.promptBudgetKB * 1024 };
}
