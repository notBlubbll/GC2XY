import { reqLog } from "./split-console.ts";

type EndpointType = "ghcp" | "vs" | "copilot" | "auth" | "other";

interface EndpointStats {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

interface UsageData {
  total: EndpointStats;
  endpoints: Record<EndpointType, EndpointStats>;
}

const _endpoints: Record<EndpointType, EndpointStats> = {
  ghcp: { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
  vs: { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
  copilot: { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
  auth: { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
  other: { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
};

const DEFAULT_COST_PER_TOKEN = 0.0000005;

export function trackRequest(endpoint: EndpointType, inputTokens = 0, outputTokens = 0) {
  const e = _endpoints[endpoint] || _endpoints.other;
  e.requests++;
  e.inputTokens += inputTokens;
  e.outputTokens += outputTokens;
  if (outputTokens > 0) {
    e.cost += outputTokens * DEFAULT_COST_PER_TOKEN;
  }
}

export function detectEndpoint(req: { url?: string; method?: string; headers?: Record<string, string> }): EndpointType {
  const url = req.url || "";
  const ua = (req.headers?.["user-agent"] || "").toLowerCase();
  const host = (req.headers?.["host"] || "").toLowerCase();

  if (ua.startsWith("github-app/")) return "ghcp";
  if (ua.includes("vscopilotclient")) return "copilot";
  const _edVer = (req.headers?.["editor-version"] || "").toLowerCase();
  const _interactionType = req.headers?.["x-interaction-type"] || "";
  if (ua.includes("vsteamexplorer") || _edVer.includes("vs/visualstudio") || _edVer.startsWith("vs/ssms") || _interactionType.includes("ssmsagent")) return "vs";
  if (host.includes("githubcopilot.com") || host.includes("copilot-proxy")) {
    if (url.includes("/chat/completions") || url.includes("/v1/messages") || url.includes("/responses") || url.includes("/agents/")) {
      return _edVer.includes("vs/visualstudio") || _edVer.startsWith("vs/ssms") || _interactionType.includes("ssmsagent") ? "vs" : "copilot";
    }
    return "copilot";
  }
  if (url.includes("/login/") || url.includes("/user") || url.includes("/copilot_internal/")) return "auth";
  if (url.includes("/repo") || url.includes("/repos/")) return "auth";
  if (url.includes("/models") || url.includes("/completions") || url.includes("/embeddings") || url.includes("/tokenize")) return "copilot";
  return "other";
}

export function getUsageData(): UsageData {
  const total: EndpointStats = { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
  for (const key of Object.keys(_endpoints) as EndpointType[]) {
    const e = _endpoints[key];
    total.requests += e.requests;
    total.inputTokens += e.inputTokens;
    total.outputTokens += e.outputTokens;
    total.cost += e.cost;
  }
  return { total, endpoints: { ..._endpoints } };
}

export function getPercentages(): Record<EndpointType, { requestPct: number; tokenPct: number; costPct: number }> {
  const data = getUsageData();
  const total = data.total;
  const result: any = {};
  for (const key of Object.keys(data.endpoints) as EndpointType[]) {
    const e = data.endpoints[key];
    result[key] = {
      requestPct: total.requests > 0 ? Math.round((e.requests / total.requests) * 10000) / 100 : 0,
      tokenPct: (total.inputTokens + total.outputTokens) > 0 ? Math.round(((e.inputTokens + e.outputTokens) / (total.inputTokens + total.outputTokens)) * 10000) / 100 : 0,
      costPct: total.cost > 0 ? Math.round((e.cost / total.cost) * 10000) / 100 : 0,
    };
  }
  return result as Record<EndpointType, { requestPct: number; tokenPct: number; costPct: number }>;
}

export function resetUsage() {
  for (const key of Object.keys(_endpoints) as EndpointType[]) {
    const e = _endpoints[key];
    e.requests = 0;
    e.inputTokens = 0;
    e.outputTokens = 0;
    e.cost = 0;
  }
}
