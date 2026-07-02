// Models aggregator — collects model IDs from all provider clients
// and pushes the combined list to the console dashboard.
//
// The OC-GO provider (opencode.ai/zen/go/v1) has been removed. Unprefixed
// models are no longer served; every model must belong to a concrete provider
// (umans, agnes, codestral, freebuff, bitnet, ...).

import { setModelsList } from "./split-console.ts";
import { initFreebuffModels, getFreebuffModelIds } from "./handlers/freebuff-client.ts";
import { initModels as initAgnes, getModelIds as getAgnes } from "./handlers/agnes-client.ts";
import { initModels as initCodestral, getModelIds as getCodestralIds } from "./handlers/codestral-client.ts";
import { getModelIds as getBitnetIds } from "./handlers/bitnet-client.ts";
import { initModels as initUmans, getModelIds as getUmansIds } from "./handlers/umans-client.ts";
import { initModelCtxMap } from "./handlers/openai-client.ts";

export async function addModels(): Promise<string[]> {
  // Fetch real context windows from models.dev/api.json so multipliers are
  // per-model instead of falling back to 200000 (→ 2000.01) for everything.
  // Awaited so the cache is populated before ensureModels() looks up getModelCtx().
  try { await initModelCtxMap(); } catch {}

  const results = await Promise.allSettled([
    initFreebuffModels(),
    initAgnes(),
    initCodestral(),
    initUmans(),
  ]);

  const fbIds = results[0].status === "fulfilled" ? results[0].value : [];
  const agnesIds = results[1].status === "fulfilled" ? results[1].value : [];
  const codestralIds = results[2].status === "fulfilled" ? results[2].value : [];
  const umansIds = results[3].status === "fulfilled" ? results[3].value : [];

  const all = [...new Set([...fbIds, ...agnesIds, ...codestralIds, ...getBitnetIds(), ...umansIds])];
  if (all.length === 0) console.log("[MODELS] WARNING: all providers returned empty!");
  else console.log(`[MODELS] ${all.length} models: ${all.slice(0, 8).join(", ")}${all.length > 8 ? "..." : ""}`);
  setModelsList(all);
  return all;
}

export function getModelIds(): string[] {
  return [...new Set([...getFreebuffModelIds(), ...getAgnes(), ...getCodestralIds(), ...getBitnetIds(), ...getUmansIds()])];
}
