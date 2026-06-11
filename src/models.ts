// Models aggregator — collects model IDs from all provider clients
// and pushes the combined list to the console dashboard.

import { setModelsList } from "./split-console.ts";
import { initModels as initOc, getModelIds as getOc } from "./handlers/opencode-client.ts";
import { initFreebuffModels, getFreebuffModelIds } from "./handlers/freebuff-client.ts";
import { initModels as initPoll, getModelIds as getPoll } from "./handlers/pollinations-client.ts";
import { initModels as initAgnes, getModelIds as getAgnes } from "./handlers/agnes-client.ts";
import { initModels as initCodestral, getModelIds as getCodestral } from "./handlers/codestral-client.ts";
import { getModelIds as getBitnetIds } from "./handlers/bitnet-client.ts";
import { initModels as initFeatherless, getModelIds as getFeatherless } from "./handlers/featherless-client.ts";

export async function addModels(): Promise<string[]> {
  const [ocIds, fbIds, pollIds, agnesIds, codestralIds, featherlessIds] = await Promise.all([
    initOc(),
    initFreebuffModels(),
    initPoll(),
    initAgnes(),
    initCodestral(),
    initFeatherless(),
  ]);

  const all = [...new Set([...ocIds, ...fbIds, ...pollIds, ...agnesIds, ...codestralIds, ...featherlessIds, ...getBitnetIds()])];
  setModelsList(all);
  return all;
}

export function getModelIds(): string[] {
  return [...new Set([...getOc(), ...getFreebuffModelIds(), ...getPoll(), ...getAgnes(), ...getCodestral(), ...getFeatherless(), ...getBitnetIds()])];
}
