// Device Login Emulator for github.com MITM proxy
// Routes requests to specialized handler modules
import { HandlerInput, HandlerResult, jsonResponse, isHybrid, isProxy } from "../shared.ts";
import { handleAuth } from "./auth-handler.ts";
import { handleCopilot } from "./copilot-handler.ts";
import { handleRepo } from "./repo-handler.ts";
import { handleVisualStudio } from "./vs/handler.ts";
import { handleVSShell } from "./vs-shell/index.ts";
import { handleVSLegacy } from "./vs-legacy/index.ts";
import { handleGHCPApp } from "./ghcp-app/index.ts";
import { handleSSMSChat, handleSSMSUsage } from "./ssms/index.ts";
import { isDebug } from "../split-console.ts";

export async function handleDeviceLogin(req: HandlerInput): Promise<HandlerResult> {
  try {
    let result: HandlerResult;

    // SSMS usage/quota handler runs FIRST
    result = handleSSMSUsage(req);
    if (result.handled) return result;

    // VS 2022 (17.x) legacy handler — handles ALL VS22 endpoints
    // (auth, models, chat, embeddings, agents) in one place.
    // Must run before handleVSShell and handleVisualStudio so VS22
    // gets the correct format (VS22 uses /chat/completions, not /responses).
    result = await handleVSLegacy(req);
    if (result.handled) return result;

    // Unified VS-family auth (VS Copilot Client + VS Team Explorer).
    result = handleVSShell(req);
    if (result.handled) return result;

    result = handleAuth(req);
    if (result.handled) return result;

    result = handleRepo(req);
    if (result.handled) return result;

    result = await handleGHCPApp(req);
    if (result.handled) return result;

    result = await handleSSMSChat(req);
    if (result.handled) return result;

    result = await handleVisualStudio(req);
    if (result.handled) return result;

    result = await handleCopilot(req);
    if (result.handled) return result;

    // Catch-all - skip in proxy/hybrid mode so requests pass through to real upstream
    if (isProxy() || isHybrid()) {
      return { handled: false };
    }
    const host = (req.headers?.["host"] || req.hostname || "unknown").toLowerCase();
    // Let freebuff binary downloads pass through to real upstream
    if (host.includes("codebuff.com")) {
      return { handled: false };
    }
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
