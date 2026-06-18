// Device Login Emulator for github.com MITM proxy
// Routes requests to specialized handler modules
import { HandlerInput, HandlerResult, jsonResponse, isHybrid, isProxy } from "../shared.ts";
import { handleAuth } from "./auth-handler.ts";
import { handleCopilot } from "./copilot-handler.ts";
import { handleRepo } from "./repo-handler.ts";
import { handleVisualStudio } from "./vs/handler.ts";
import { handleVSShell } from "./vs-shell/index.ts";
import { handleGHCPApp } from "./ghcp-app/index.ts";
import { handleSQLStudioChat, handleSSMSUsage } from "./sql-studio/index.ts";
import { isDebug } from "../split-console.ts";

export async function handleDeviceLogin(req: HandlerInput): Promise<HandlerResult> {
  try {
    let result: HandlerResult;

    // SSMS usage/quota handler runs FIRST — SSMS uses a different quota
    // format than VS (full quota_snapshots with token_based_billing) and
    // breaks if it gets the VS-style 6-field format. Only handles
    // /copilot_internal/user and /copilot_internal/v2/token for SSMS clients.
    result = handleSSMSUsage(req);
    if (result.handled) return result;

    // Unified VS-family auth (VS Copilot Client + VS Team Explorer).
    // Handles copilot_internal/* for both, and explicitly passes through
    // OAuth/login routes so handleAuth can issue fake tokens — the VS
    // chat handler's catch-all would otherwise swallow them with a
    // token-less mock and break sign-in (VS error 723).
    result = handleVSShell(req);
    if (result.handled) return result;

    result = handleAuth(req);
    if (result.handled) return result;

    result = handleRepo(req);
    if (result.handled) return result;

    result = await handleGHCPApp(req);
    if (result.handled) return result;

    // VS Team Explorer chat requests spoof editor-version then delegate to
    // the VS chat handler. Auth routes already handled above by handleVSShell.
    result = await handleSQLStudioChat(req);
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
