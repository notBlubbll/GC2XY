// Models aggregator — collects model IDs from all provider clients
// and pushes the combined list to the console dashboard.

import { setModelsList } from "./split-console.ts";
import { initModels as initOc, getModelIds as getOc } from "./handlers/opencode-client.ts";
import { initFreebuffModels, getFreebuffModelIds } from "./handlers/freebuff-client.ts";
import { initModels as initAgnes, getModelIds as getAgnes } from "./handlers/agnes-client.ts";
import { initModels as initCodestral, getModelIds as getCodestralIds } from "./handlers/codestral-client.ts";
import { getModelIds as getBitnetIds } from "./handlers/bitnet-client.ts";

export async function addModels(): Promise<string[]> {
  const [ocIds, fbIds, agnesIds, codestralIds] = await Promise.all([
    initOc(),
    initFreebuffModels(),
    initAgnes(),
    initCodestral(),
  ]);

  const all = [...new Set([...ocIds, ...fbIds, ...agnesIds, ...codestralIds, ...getBitnetIds()])];
  setModelsList(all);
  return all;
}

export function getModelIds(): string[] {
  return [...new Set([...getOc(), ...getFreebuffModelIds(), ...getAgnes(), ...getCodestralIds(), ...getBitnetIds()])];
}
