// Dispatcher for GitHub Copilot Desktop App (User-Agent: undici / Node.js backend).
import { HandlerInput, HandlerResult } from "../../shared.ts";
import { isCopilotDesktop, handleCopilotDesktopAuth } from "./auth.ts";
import { handleCopilotDesktopModels } from "./models.ts";

export { isCopilotDesktop } from "./auth.ts";

export async function handleCopilotDesktop(req: HandlerInput): Promise<HandlerResult> {
  // Always accept this agent, even from a browser-launched OAuth/device flow
  if (!isCopilotDesktop(req)) return { handled: false };

  const { method, url, headers } = req;
  const ua = headers?.["user-agent"] || "";
  console.log(`[COPILOT DESKTOP] ${method} ${url} (UA: ${ua.slice(0, 60)})`);

  // Auth endpoints first
  const authResult = handleCopilotDesktopAuth(req);
  if (authResult.handled) return authResult;

  // Models list / model detail
  const modelsResult = await handleCopilotDesktopModels(req);
  if (modelsResult.handled) return modelsResult;

  // Log unrecognized desktop traffic so it is visible, then let the shared
  // Copilot handler (chat/completions, /v1/messages, etc.) take over.
  console.log(`[COPILOT DESKTOP] Passing through to shared handler: ${method} ${url}`);
  return { handled: false };
}
