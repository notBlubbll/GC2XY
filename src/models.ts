// Models aggregator — collects model IDs from all provider clients
// and pushes the combined list to the console dashboard.

import { setModelsList } from "./split-console.ts";
import { initFreebuffModels, getFreebuffModelIds } from "./handlers/freebuff-client.ts";
import { initModels as initAgnes, getModelIds as getAgnes } from "./handlers/agnes-client.ts";
import { initModels as initCodestral, getModelIds as getCodestralIds } from "./handlers/codestral-client.ts";
import { getModelIds as getBitnetIds } from "./handlers/bitnet-client.ts";
import { initModels as initUmans, getModelIds as getUmansIds } from "./handlers/umans-client.ts";

export async function addModels(): Promise<string[]> {
  const [fbIds, agnesIds, codestralIds, umansIds] = await Promise.all([
    initFreebuffModels(),
    initAgnes(),
    initCodestral(),
    initUmans(),
  ]);

  const all = [...new Set([...fbIds, ...agnesIds, ...codestralIds, ...getBitnetIds(), ...umansIds])];
  setModelsList(all);
  return all;
}

export function getModelIds(): string[] {
  return [...new Set([...getFreebuffModelIds(), ...getAgnes(), ...getCodestralIds(), ...getBitnetIds(), ...getUmansIds()])];
}
