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
import { handleCopilotDesktop } from "./copilot-desktop/index.ts";
import { handleSSMSChat, handleSSMSUsage } from "./ssms/index.ts";
import { isDebug } from "../split-console.ts";

// ── VS Application Insights telemetry interceptor ──────────────────────────
// dc.services.visualstudio.com receives VS Copilot "is this helpful" votes,
// feedback signals, and other AI telemetry as JSON POST payloads.
// We log the body so voting/feedback is visible in the console, then return 200.
function handleVSTelemetry(req: HandlerInput): HandlerResult {
  const { method, url, body, hostname } = req;
  if (!hostname.includes("dc.services.visualstudio.com")) return { handled: false };
  if (method === "POST") {
    try {
      const text = body?.toString() || "";
      const preview = text.slice(0, 500);
      if (text.includes("helpful") || text.includes("feedback") || text.includes("vote") ||
          text.includes("thumbs") || text.includes("rating") || text.includes("is_helpful")) {
        console.log(`[VS TELEMETRY] VOTE/FEEDBACK detected: ${preview}`);
      } else {
        console.log(`[VS TELEMETRY] ${method} ${url} (${text.length} bytes) preview: ${preview.slice(0, 200)}`);
      }
    } catch {}
  }
  return { handled: true, response: jsonResponse({ itemsReceived: 1, itemsAccepted: 1 }) };
}

export async function handleDeviceLogin(req: HandlerInput): Promise<HandlerResult> {
  try {
    let result: HandlerResult;

    // VS Application Insights telemetry (voting/feedback) runs FIRST
    result = handleVSTelemetry(req);
    if (result.handled) return result;

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

    // GitHub Copilot Desktop App (undici UA) gets its own handler lane
    result = await handleCopilotDesktop(req);
    if (result.handled) return result;

    // GitHub App for Windows (github-app/* UA) — run before generic auth so
    // GHCP-specific paths like autopilot team membership are handled first.
    result = await handleGHCPApp(req);
    if (result.handled) return result;

    result = handleAuth(req);
    if (result.handled) return result;

    result = handleRepo(req);
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
