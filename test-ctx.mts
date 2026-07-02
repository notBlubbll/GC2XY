import { getModelCtx, initModelCtxMap } from "./src/handlers/openai-client.ts";
await initModelCtxMap();
const ids = ["umans-kimi-k2.7","kimi-k2.7","umans-glm-5.2","glm-5.2","deepseek-v4-flash","umans-flash","agnes-2.0-flash","umans-qwen3.6-35b-a3b","qwen3.6-35b-a3b","big-pickle","minimax-m2.7","umans-coder"];
for (const id of ids) {
  const ctx = getModelCtx(id);
  const mult = ctx ? (ctx/100+0.01).toFixed(2) : "fallback";
  console.log(`  ${id} -> ctx=${ctx} mult=${mult}`);
}
