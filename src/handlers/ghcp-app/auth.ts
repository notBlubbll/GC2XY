import { jsonResponse, HandlerInput, HandlerResult } from "../../shared.ts";

export function isGHCPApp(req: HandlerInput): boolean {
  const ua = req.headers?.["user-agent"] || "";
  return ua.startsWith("github-app/");
}

// GHCP app copilot user — different billing/plan fields
export function handleGHCPCopilotUser(req: HandlerInput): HandlerResult | null {
  const { method, url } = req;
  if (method !== "GET" || !url.includes("/copilot_internal/user")) return null;
  return null; // Fall through to default auth handler for now
}

// GHCP app copilot v2 token
export function handleGHCPToken(req: HandlerInput): HandlerResult | null {
  const { method, url } = req;
  if (method !== "GET" || !url.startsWith("/copilot_internal/v2/token")) return null;
  return null; // Fall through to default auth handler for now
}

// GHCP app content exclusion
export function handleGHCPContentExclusion(req: HandlerInput): HandlerResult | null {
  const { method, url } = req;
  if (method !== "GET" || !url.includes("/copilot_internal/content_exclusion")) return null;
  return null; // Fall through to default auth handler for now
}
