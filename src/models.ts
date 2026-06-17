// Models aggregator — collects model IDs from all provider clients
// and pushes the combined list to the console dashboard.

import { setModelsList } from "./split-console.ts";
import { initFreebuffModels, getFreebuffModelIds } from "./handlers/freebuff-client.ts";
import { initModels as initAgnes, getModelIds as getAgnes } from "./handlers/agnes-client.ts";
import { initModels as initCodestral, getModelIds as getCodestralIds } from "./handlers/codestral-client.ts";
import { getModelIds as getBitnetIds } from "./handlers/bitnet-client.ts";
import { initModels as initUmans, getModelIds as getUmansIds } from "./handlers/umans-client.ts";
import { initModels as initGo, getModelIds as getGoIds } from "./handlers/openai-provider.ts";

export async function addModels(): Promise<string[]> {
  const [fbIds, agnesIds, codestralIds, umansIds, goIds] = await Promise.all([
    initFreebuffModels(),
    initAgnes(),
    initCodestral(),
    initUmans(),
    initGo(),
  ]);

  const all = [...new Set([...fbIds, ...agnesIds, ...codestralIds, ...getBitnetIds(), ...umansIds, ...goIds])];
  setModelsList(all);
  return all;
}

export function getModelIds(): string[] {
  return [...new Set([...getFreebuffModelIds(), ...getAgnes(), ...getCodestralIds(), ...getBitnetIds(), ...getUmansIds(), ...getGoIds()])];
}
