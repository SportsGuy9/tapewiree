// Settings come from (in order of precedence) environment variables, a .env file and tapewire.config.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KEY_SPECS } from "./keys.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readDotEnv(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || line.trim().startsWith("#")) continue;
      const v = m[2]; out[m[1]] = /^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v.replace(/(^|\s+)#.*$/, "").trim();
    }
  } catch (e) { /* no .env */ }
  return out;
}

export function loadConfig() {
  const dot = readDotEnv(path.join(ROOT, ".env"));
  const env = (k) => process.env[k] ?? dot[k] ?? "";
  let file = {};
  const cfgPath = path.join(ROOT, "tapewire.config.json");
  try { file = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch (e) { if (fs.existsSync(cfgPath)) console.warn(`[config] tapewire.config.json is not valid JSON: ${e.message}`); }
  const a = file.anthropic || {};
  const model = env("TAPEWIRE_MODEL") || a.model || "claude-opus-5-5";
  return {
    port: +(env("PORT") || file.port || 8787),
    host: env("HOST") || file.host || "127.0.0.1",
    dataDir: path.resolve(ROOT, env("TAPEWIRE_DATA_DIR") || file.dataDir || "data"),
    anthropic: {
      apiKey: env("ANTHROPIC_API_KEY") || a.apiKey || "",
      // every tier runs the same model; the tier only changes how hard it thinks
      models: { quick: model, default: model, complex: model, ...(a.models || {}) },
      effort: { quick: "low", default: "medium", complex: "high", ...(a.effort || {}) },
      maxTokens: a.maxTokens || 32000,
      fallbacks: a.fallbacks !== false,
      promptBudgetKB: +(env("TAPEWIRE_PROMPT_KB") || a.promptBudgetKB || 160)
    },
    keys: Object.fromEntries(KEY_SPECS.map((k) => [k.id, env(k.env) || file.keys?.[k.id] || ""])),
    mcpUrls: { cmc: env("COINMARKETCAP_MCP_URL") || "https://mcp.coinmarketcap.com/mcp", bigdata: env("BIGDATA_MCP_URL") || "https://mcp.bigdata.com/", dune: env("DUNE_MCP_URL") || "https://api.dune.com/mcp/v1" },
    // optional remote MCP servers, keyed by the connector name the page uses
    mcp: file.mcp || {},
    backupsKeep: file.backupsKeep || 21
  };
}
