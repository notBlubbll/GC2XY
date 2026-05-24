// Device Login Emulator for github.com MITM proxy
// Routes requests to specialized handler modules
import { HandlerInput, HandlerResult, jsonResponse } from "../shared.ts";
import { handleAuth } from "./auth-handler.ts";
import { handleCopilot } from "./copilot-handler.ts";
import { handleRepo } from "./repo-handler.ts";
import { handleVisualStudio } from "./vs/handler.ts";
import { handleVSAuth } from "./vs/auth.ts";
import { handleGHCPApp } from "./ghcp-app/index.ts";
import { isDebug } from "../split-console.ts";

export async function handleDeviceLogin(req: HandlerInput): Promise<HandlerResult> {
  try {
    let result: HandlerResult;

    result = handleVSAuth(req);
    if (result.handled) return result;

    result = handleAuth(req);
    if (result.handled) return result;

    result = handleRepo(req);
    if (result.handled) return result;

    result = await handleGHCPApp(req);
    if (result.handled) return result;

    result = await handleVisualStudio(req);
    if (result.handled) return result;

    result = await handleCopilot(req);
    if (result.handled) return result;

    // Catch-all - skip in hybrid mode so non-mocked requests pass through
    const ARGS = new Set(typeof process !== "undefined" ? process.argv.slice(2) : []);
    const isHybrid = ARGS.has("--mode-2");
    if (isHybrid) {
      return { handled: false };
    }
    const host = req.headers?.["host"] || req.hostname || "unknown";
    if (isDebug()) console.log(`\n[FAKE GHE] Catch-all intercepting: ${req.method} ${req.url} [${host}]`);
    return {
      handled: true,
      response: jsonResponse({ ok: true, message: "fake response" }),
    };
  } catch (e: any) {
    console.log(`\n[FAKE GHE] Handler error: ${e.message}`);
    return { handled: true, response: jsonResponse({ error: e.message, ok: false }, 500) };
  }
}
