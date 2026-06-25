// BitNet provider — CPU inference endpoint
// Prefix: bitnet/

const BASE = "https://demo-bitnet-h0h8hcfqeqhrf5gf.canadacentral-01.azurewebsites.net";

export interface BitNetModelInfo {
  family: string;
  paramCount: number;
  contextLength: number;
  capabilities: string[];
}

const MODELS: Record<string, BitNetModelInfo> = {
  "other:bitnet-demo": { family: "qwen2.5", paramCount: 1500000000, contextLength: 8192, capabilities: ["completion"] },
};

export function getModelIds(): string[] {
  return Object.keys(MODELS);
}

export function getModelInfo(modelId: string): BitNetModelInfo | undefined {
  return MODELS[modelId];
}

function randomId(prefix: string, len = 12): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < len; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}_${id}`;
}

export async function chatCompletion(
  _modelId: string,
  messages: any[],
  _tools?: any[],
  stream = true,
  _extra: Record<string, any> = {}
): Promise<Response> {
  const body = {
    messages,
    userId: "user_weepwicgts",
    chatId: "chat_yb3e8o01y6o",
    device: "cpu",
  };

  const url = `${BASE}/completion`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45000);
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeoutId));

  const raw = await resp.text();
  if (!resp.ok) {
    return new Response(JSON.stringify({ error: { message: `BitNet error ${resp.status}: ${raw.slice(0, 500)}`, type: "server_error" } }), {
      status: resp.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const parts: string[] = [];
  const events = raw.split("\n\n");
  for (const event of events) {
    const trimmed = event.trim();
    if (!trimmed.startsWith("data: ")) continue;
    const jsonStr = trimmed.slice(6);
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed.finished) continue;
      if (parsed.content) parts.push(parsed.content);
    } catch {
      continue;
    }
  }
  const fullContent = parts.join("");

  if (stream) {
    const chunk = JSON.stringify({ choices: [{ delta: { content: fullContent }, finish_reason: null }] });
    const done = "data: [DONE]";
    const sse = `data: ${chunk}\n\n${done}\n\n`;
    return new Response(sse, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  }

  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: fullContent }, finish_reason: "stop" }] }), {
    headers: { "Content-Type": "application/json" },
  });
}
