// Convert upstream OpenAI chat-completion responses into OpenAI Responses API
// format for Visual Studio's /responses endpoint.
import forge from "node-forge";

function randomRespId() {
  return `resp_${forge.util.bytesToHex(forge.random.getBytesSync(16))}`;
}
function randomItemId() {
  return `item_${forge.util.bytesToHex(forge.random.getBytesSync(12))}`;
}
function randomCallId() {
  return `call_${forge.util.bytesToHex(forge.random.getBytesSync(12))}`;
}

export interface ResponsesOptions {
  model: string;
  previous_response_id?: string | null;
  instructions?: string;
  reasoning?: { effort?: string; summary?: string } | null;
  tools?: any[];
  tool_choice?: any;
  temperature?: number | null;
  top_p?: number | null;
  max_output_tokens?: number | null;
  parallel_tool_calls?: boolean;
  text?: any;
  store?: boolean;
}

function toResponsesToolFormat(tools: any[]): any[] {
  if (!Array.isArray(tools)) return [];
  return tools.map((t: any) => {
    if (t.type === "function" && t.function) {
      const { name, description, parameters } = t.function;
      const out: any = { type: "function", name: name || "" };
      if (description) out.description = description;
      if (parameters) out.parameters = parameters;
      return out;
    }
    return t;
  });
}

function baseResponse(respId: string, model: string, opts: ResponsesOptions): any {
  const ts = Math.floor(Date.now() / 1000);
  const effort = opts.reasoning?.effort;
  const summaryUpgrade = opts.reasoning?.summary === "auto" ? "detailed" : (opts.reasoning?.summary || "auto");
  return {
    id: respId,
    object: "response",
    created_at: ts,
    model,
    status: "in_progress",
    error: null,
    incomplete_details: null,
    instructions: opts.instructions || null,
    metadata: {},
    output: [],
    parallel_tool_calls: opts.parallel_tool_calls ?? true,
    previous_response_id: opts.previous_response_id || null,
    reasoning: opts.reasoning ? { effort: effort || "medium", summary: summaryUpgrade, context: null } : null,
    temperature: opts.temperature ?? 1,
    top_p: opts.top_p ?? null,
    max_output_tokens: opts.max_output_tokens ?? null,
    truncation: null,
    usage: null,
    background: false,
    completed_at: null,
    content_filters: null,
    frequency_penalty: 0,
    max_tool_calls: null,
    moderation: null,
    presence_penalty: 0,
    prompt_cache_retention: "in_memory",
    safety_identifier: forge.util.bytesToHex(forge.random.getBytesSync(32)),
    service_tier: "auto",
    store: opts.store ?? false,
    text: opts.text || { format: { type: "text" }, verbosity: "medium" },
    tool_choice: opts.tool_choice ?? "auto",
    tools: toResponsesToolFormat(opts.tools || []),
  };
}

/** Build a synthetic Responses API response containing a single task_complete function call. */
export function buildResponsesTaskComplete(model: string): any {
  const respId = randomRespId();
  const itemId = randomItemId();
  const callId = "call_task_complete";
  const resp = baseResponse(respId, model, { model });
  resp.status = "completed";
  resp.output = [{
    id: itemId,
    type: "function_call",
    status: "completed",
    call_id: callId,
    name: "task_complete",
    arguments: "{}",
  }];
  resp.usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  return resp;
}

/** Non-streaming: build a complete Responses API response object. */
export function buildResponsesFromChatCompletion(data: any, opts: ResponsesOptions): any {
  const respId = randomRespId();
  const choice = data.choices?.[0];
  const assistantMsg = choice?.message || { role: "assistant", content: "", tool_calls: [] };
  const contentText = typeof assistantMsg.content === "string" ? (assistantMsg.content || "") : "";
  const toolCalls = Array.isArray(assistantMsg.tool_calls) ? assistantMsg.tool_calls : [];

  const output: any[] = [];
  if (contentText) {
    output.push({
      id: randomItemId(),
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: contentText, annotations: [] }],
    });
  }
  for (const tc of toolCalls) {
    const fn = tc.function || tc;
    output.push({
      id: tc.id || randomItemId(),
      type: "function_call",
      status: "completed",
      call_id: randomCallId(),
      name: fn.name || "unknown",
      arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}),
    });
  }

  const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  const summaryUpgrade = opts.reasoning?.summary === "auto" ? "detailed" : (opts.reasoning?.summary || "auto");
  const finalOutput: any[] = [];
  if (opts.reasoning && (opts.reasoning.effort || opts.reasoning.summary)) {
    finalOutput.push({
      id: randomItemId(),
      type: "reasoning",
      summary: summaryUpgrade,
      encrypted_content: "",
    });
  }
  finalOutput.push(...output);

  const resp = baseResponse(respId, opts.model, opts);
  resp.status = "completed";
  resp.output = finalOutput;
  resp.completed_at = Math.floor(Date.now() / 1000);
  resp.usage = { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0, total_tokens: usage.total_tokens || 0 };
  return resp;
}

interface AccState {
  text: string;
  contentStarted: boolean;
  toolCalls: Record<number, { id: string; name: string; args: string; callId: string; emitted: boolean }>;
}

let seqCounter = 0;
function nextSeq() { return seqCounter++; }

/** Streaming: read chat-completion SSE and emit Responses API SSE chunks.
 *  Mirrors the real GitHub /responses streaming format captured from VS. */
export async function* streamChatCompletionToResponses(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  opts: ResponsesOptions,
): AsyncGenerator<string, void, unknown> {
  const respId = randomRespId();
  const messageId = randomItemId();
  const decoder = new TextDecoder();
  const acc: AccState = { text: "", contentStarted: false, toolCalls: {} };

  const createdResp = baseResponse(respId, opts.model, opts);
  yield sseEvent("response.created", { response: createdResp, sequence_number: nextSeq(), type: "response.created" });
  yield sseEvent("response.in_progress", { response: createdResp, sequence_number: nextSeq(), type: "response.in_progress" });

  // Emit a reasoning output item before the message if reasoning is enabled. This mirrors real GitHub.
  const hasReasoning = !!(opts.reasoning && (opts.reasoning.effort || opts.reasoning.summary));
  const reasoningId = hasReasoning ? randomItemId() : null;
  const streamSummaryUpgrade = opts.reasoning?.summary === "auto" ? "detailed" : (opts.reasoning?.summary || "auto");
  if (hasReasoning && reasoningId) {
    yield sseEvent("response.output_item.added", {
      output_index: 0,
      item: { id: reasoningId, type: "reasoning" },
      sequence_number: nextSeq(),
      type: "response.output_item.added",
    });
    yield sseEvent("response.output_item.done", {
      output_index: 0,
      item: { id: reasoningId, type: "reasoning", summary: streamSummaryUpgrade },
      sequence_number: nextSeq(),
      type: "response.output_item.done",
    });
  }

  yield sseEvent("response.output_item.added", { output_index: 1, item: { id: messageId, type: "message", status: "in_progress", role: "assistant", content: [] }, sequence_number: nextSeq(), type: "response.output_item.added" });

  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const evt = parseChatCompletionSseLine(line);
      if (!evt) continue;
      for (const chunk of handleChatDelta(evt, acc, messageId, opts.model)) {
        yield chunk;
      }
    }
  }
  if (buffer.trim()) {
    const evt = parseChatCompletionSseLine(buffer);
    if (evt) {
      for (const chunk of handleChatDelta(evt, acc, messageId, opts.model)) {
        yield chunk;
      }
    }
  }

  // Emit content_part.done / output_text.done
  if (acc.text && acc.contentStarted) {
    yield sseEvent("response.output_text.done", { output_index: 1, content_index: 0, item_id: messageId, sequence_number: nextSeq(), type: "response.output_text.done" });
    yield sseEvent("response.content_part.done", { output_index: 1, content_index: 0, item_id: messageId, part: { type: "output_text", text: acc.text, annotations: [] }, sequence_number: nextSeq(), type: "response.content_part.done" });
  }

  // Finalize message item
  const finalContent = acc.text ? [{ type: "output_text", text: acc.text, annotations: [] }] : [];
  yield sseEvent("response.output_item.done", { output_index: 1, item: { id: messageId, type: "message", role: "assistant", status: "completed", content: finalContent }, sequence_number: nextSeq(), type: "response.output_item.done" });

  // Finalize any tool calls
  const toolIndices = Object.keys(acc.toolCalls).map(Number).sort((a, b) => a - b);
  for (let i = 0; i < toolIndices.length; i++) {
    const idx = toolIndices[i];
    const tc = acc.toolCalls[idx];
    const outIdx = 2 + i;
    yield sseEvent("response.output_item.done", {
      output_index: outIdx,
      item: { id: tc.id, type: "function_call", status: "completed", call_id: tc.callId, name: tc.name, arguments: tc.args || "{}" },
      sequence_number: nextSeq(),
      type: "response.output_item.done",
    });
  }

  // Final response.completed uses the SAME base response object so all envelope fields match
  createdResp.status = "completed";
  createdResp.completed_at = Math.floor(Date.now() / 1000);
  createdResp.output = [];
  if (hasReasoning && reasoningId) {
    createdResp.output.push({ id: reasoningId, type: "reasoning", summary: streamSummaryUpgrade, encrypted_content: "" });
  }
  if (finalContent.length) {
    createdResp.output.push({ id: messageId, type: "message", role: "assistant", status: "completed", content: finalContent });
  }
  for (let i = 0; i < toolIndices.length; i++) {
    const tc = acc.toolCalls[toolIndices[i]];
    createdResp.output.push({ id: tc.id, type: "function_call", status: "completed", call_id: tc.callId, name: tc.name, arguments: tc.args || "{}" });
  }
  createdResp.usage = { input_tokens: 0, output_tokens: acc.text.length, total_tokens: acc.text.length };
  yield sseEvent("response.completed", { response: createdResp, sequence_number: nextSeq(), type: "response.completed" });
}

/** Convert a completed Responses API object into a series of SSE events.
 *  Used when the upstream returned a full JSON response but the client requested streaming. */
export async function* streamResponsesObjectToSSE(respObj: any): AsyncGenerator<string, void, unknown> {
  const resp = { ...respObj };
  const respId = resp.id || randomRespId();
  resp.id = respId;

  yield sseEvent("response.created", { response: { ...resp, status: "in_progress", output: [] }, sequence_number: nextSeq(), type: "response.created" });
  yield sseEvent("response.in_progress", { response: { ...resp, status: "in_progress", output: [] }, sequence_number: nextSeq(), type: "response.in_progress" });

  let outputIndex = 0;
  for (const item of resp.output || []) {
    if (item.type === "reasoning") {
      yield sseEvent("response.output_item.added", { output_index: outputIndex, item: { ...item, status: "in_progress" }, sequence_number: nextSeq(), type: "response.output_item.added" });
      yield sseEvent("response.output_item.done", { output_index: outputIndex, item: item, sequence_number: nextSeq(), type: "response.output_item.done" });
      outputIndex++;
      continue;
    }

    if (item.type === "message") {
      yield sseEvent("response.output_item.added", { output_index: outputIndex, item: { ...item, status: "in_progress" }, sequence_number: nextSeq(), type: "response.output_item.added" });
      const contentParts = item.content || [];
      let contentIndex = 0;
      for (const part of contentParts) {
        if (part.type === "output_text" || part.type === "text") {
          const text = part.text || "";
          yield sseEvent("response.content_part.added", {
            output_index: outputIndex,
            content_index: contentIndex,
            item_id: item.id,
            part: { type: "output_text", text: "", annotations: [] },
            sequence_number: nextSeq(),
            type: "response.content_part.added",
          });
          // Stream text word-by-word for a responsive feel
          const words = text.split(/(?=\s)/g);
          for (const word of words) {
            yield sseEvent("response.output_text.delta", {
              output_index: outputIndex,
              content_index: contentIndex,
              item_id: item.id,
              delta: word,
              logprobs: [],
              obfuscation: "",
              sequence_number: nextSeq(),
              type: "response.output_text.delta",
            });
          }
          yield sseEvent("response.output_text.done", {
            output_index: outputIndex,
            content_index: contentIndex,
            item_id: item.id,
            sequence_number: nextSeq(),
            type: "response.output_text.done",
          });
          yield sseEvent("response.content_part.done", {
            output_index: outputIndex,
            content_index: contentIndex,
            item_id: item.id,
            part: { type: "output_text", text, annotations: [] },
            sequence_number: nextSeq(),
            type: "response.content_part.done",
          });
        }
        contentIndex++;
      }
      yield sseEvent("response.output_item.done", {
        output_index: outputIndex,
        item,
        sequence_number: nextSeq(),
        type: "response.output_item.done",
      });
      outputIndex++;
      continue;
    }

    if (item.type === "function_call") {
      yield sseEvent("response.output_item.added", {
        output_index: outputIndex,
        item: { ...item, status: "in_progress" },
        sequence_number: nextSeq(),
        type: "response.output_item.added",
      });
      const args = item.arguments || "{}";
      yield sseEvent("response.function_call_arguments.delta", {
        output_index: outputIndex,
        call_id: item.call_id,
        delta: args,
        sequence_number: nextSeq(),
        type: "response.function_call_arguments.delta",
      });
      yield sseEvent("response.function_call_arguments.done", {
        output_index: outputIndex,
        call_id: item.call_id,
        arguments: args,
        sequence_number: nextSeq(),
        type: "response.function_call_arguments.done",
      });
      yield sseEvent("response.output_item.done", {
        output_index: outputIndex,
        item,
        sequence_number: nextSeq(),
        type: "response.output_item.done",
      });
      outputIndex++;
      continue;
    }
  }

  yield sseEvent("response.completed", { response: resp, sequence_number: nextSeq(), type: "response.completed" });
}

function sseEvent(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseChatCompletionSseLine(line: string): any {
  const t = line.trim();
  if (!t || t === "data: [DONE]") return null;
  if (t.startsWith("data: ")) {
    try { return JSON.parse(t.slice(6)); } catch { return null; }
  }
  return null;
}

function* handleChatDelta(d: any, acc: AccState, messageId: string, model: string): Generator<string> {
  const delta = d.choices?.[0]?.delta;
  if (!delta) return;

  if (delta.content) {
    if (!acc.contentStarted) {
      acc.contentStarted = true;
      yield sseEvent("response.content_part.added", {
        output_index: 1,
        content_index: 0,
        item_id: messageId,
        part: { type: "output_text", text: "", annotations: [], logprobs: [] },
        sequence_number: nextSeq(),
        type: "response.content_part.added",
      });
    }
    acc.text += delta.content;
    yield sseEvent("response.output_text.delta", {
      output_index: 1,
      content_index: 0,
      item_id: messageId,
      delta: delta.content,
      logprobs: [],
      obfuscation: "",
      sequence_number: nextSeq(),
      type: "response.output_text.delta",
    });
  }

  // Emit reasoning as text too so VS doesn't hang waiting for content
  if (delta.reasoning_content) {
    if (!acc.contentStarted) {
      acc.contentStarted = true;
      yield sseEvent("response.content_part.added", {
        output_index: 1,
        content_index: 0,
        item_id: messageId,
        part: { type: "output_text", text: "", annotations: [], logprobs: [] },
        sequence_number: nextSeq(),
        type: "response.content_part.added",
      });
    }
    acc.text += delta.reasoning_content;
    yield sseEvent("response.output_text.delta", {
      output_index: 1,
      content_index: 0,
      item_id: messageId,
      delta: delta.reasoning_content,
      logprobs: [],
      obfuscation: "",
      sequence_number: nextSeq(),
      type: "response.output_text.delta",
    });
  }

  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      const idx = typeof tc.index === "number" ? tc.index : 0;
      if (!acc.toolCalls[idx]) {
        acc.toolCalls[idx] = { id: tc.id || randomItemId(), name: "", args: "", callId: randomCallId(), emitted: false };
      }
      const t = acc.toolCalls[idx];
      if (tc.id) t.id = tc.id;
      if (tc.function?.name) t.name += tc.function.name;
      if (tc.function?.arguments) t.args += tc.function.arguments;

      if (!t.emitted) {
        t.emitted = true;
        yield sseEvent("response.output_item.added", {
          output_index: 2 + idx,
          item: { id: t.id, type: "function_call", status: "in_progress", call_id: t.callId, name: t.name || "", arguments: "" },
          sequence_number: nextSeq(),
          type: "response.output_item.added",
        });
      }
      if (tc.function?.arguments) {
        yield sseEvent("response.function_call_arguments.delta", {
          output_index: 2 + idx,
          call_id: t.callId,
          delta: tc.function.arguments,
          sequence_number: nextSeq(),
          type: "response.function_call_arguments.delta",
        });
      }
    }
  }
}

/** Flatten an OpenAI Responses API `input` (string, role/content array, or typed items) into chat messages. */
export function flattenResponsesInput(input: any): { messages: any[]; system?: string } {
  const messages: any[] = [];
  let system = "";

  if (typeof input === "string") {
    if (input) messages.push({ role: "user", content: input });
    return { messages, system };
  }

  const items = Array.isArray(input) ? input : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;

    // Plain role/content message objects (most common VS format)
    if (item.role) {
      const role = item.role;
      const content = flattenResponseContent(item.content);
      if (!content) continue;
      if (role === "system") {
        system = (system ? system + "\n\n" : "") + content;
      } else if (role === "assistant") {
        messages.push({ role: "assistant", content });
      } else {
        messages.push({ role: "user", content });
      }
      continue;
    }

    // Typed Responses API items
    if (item.type === "message") {
      const role = item.role === "assistant" ? "assistant" : "user";
      const content = flattenResponseContent(item.content);
      if (content) messages.push({ role, content });
    } else if (item.type === "function_call") {
      const tc = { id: item.call_id || item.id || "tool_1", type: "function", function: { name: item.name, arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || "{}") } };
      messages.push({ role: "assistant", content: null, tool_calls: [tc] });
    } else if (item.type === "function_call_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id || "tool_1", content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "") });
    }
  }
  return { messages, system };
}

function flattenResponseContent(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content) {
    if (typeof c === "string") { parts.push(c); continue; }
    if (!c || typeof c !== "object") continue;
    if (c.type === "input_text" || c.type === "output_text") parts.push(c.text || "");
    else if (c.type === "text") parts.push(c.text || "");
  }
  return parts.join("");
}
