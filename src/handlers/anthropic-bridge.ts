import { anthropicToUniversal } from "llm-bridge";

function cleanOpenAIMessages(universal: any): any[] {
  const result: any[] = [];
  const system = universal.system;

  if (system) {
    const sysText = typeof system === "string" ? system :
      typeof system === "object" ? (system.content || "") : "";
    if (sysText.trim()) result.push({ role: "system", content: sysText });
  }

  for (const msg of (universal.messages || [])) {
    const textParts: string[] = [];
    const toolCalls: any[] = [];
    const toolResults: any[] = [];

    for (const c of (msg.content || [])) {
      if (c.type === "text" && c.text) textParts.push(c.text);
      else if (c.type === "tool_call" && c.tool_call) {
        toolCalls.push({
          id: c.tool_call.id,
          type: "function",
          function: {
            name: c.tool_call.name,
            arguments: JSON.stringify(c.tool_call.arguments || {}),
          },
        });
      } else if (c.type === "tool_result" && c.tool_result) {
        toolResults.push(c.tool_result);
      } else if (c.type === "thinking") {
        // skip thinking blocks for OpenAI
      }
    }

    if (msg.role === "assistant") {
      const out: any = { role: "assistant" };
      out.content = textParts.join(" ") || null;
      const allCalls = [...toolCalls, ...(msg.tool_calls || [])];
      if (allCalls.length) out.tool_calls = allCalls;
      result.push(out);
    } else if (msg.role === "user") {
      if (textParts.length) result.push({ role: "user", content: textParts.join(" ") });
      for (const tr of toolResults) {
        const trContent = typeof tr.result === "string" ? tr.result :
          Array.isArray(tr.result) ? tr.result.map((c: any) => typeof c === "string" ? c : c.text || "").join(" ") :
          typeof tr.result === "object" ? JSON.stringify(tr.result) : String(tr.result ?? "");
        if (tr.tool_call_id) result.push({ role: "tool", tool_call_id: tr.tool_call_id, content: trContent });
      }
    } else {
      result.push({ role: msg.role, content: textParts.join(" ") || "" });
    }
  }

  return result;
}

export function anthropicToOpenAIRequest(parsed: any): {
  messages: any[];
  model: string;
  tools: any[];
  stream: boolean;
  max_tokens: number;
} {
  const universal = anthropicToUniversal(parsed) as any;
  const messages = cleanOpenAIMessages(universal);
  const model = universal.model || parsed.model || "";
  const stream = universal.stream === true;
  const max_tokens = universal.max_tokens || 4096;

  let tools: any[] = [];
  if (universal.tools?.length) {
    tools = universal.tools.map((t: any) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.parameters || {},
      },
    }));
  }

  return { messages, model, tools, stream, max_tokens };
}
