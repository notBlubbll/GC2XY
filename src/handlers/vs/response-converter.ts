// Convert upstream OpenAI chat-completion responses into OpenAI Responses API
// format for Visual Studio's /responses endpoint.
import forge from "node-forge";
import { extractNameFromToolId, repairToolCalls, detectApologyText, detectToolLoop, bumpSalvageStat } from "../../tool-salvager.ts";

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
  // Conversation history so the salvager's detectToolLoop can walk prior
  // assistant turns. Without this, loop detection silently no-ops on the
  // /responses streaming path and stuck tool calls repeat forever.
  messages?: any[];
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
  resp.usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
  return resp;
}

/** Non-streaming: build a complete Responses API response object. */
export function buildResponsesFromChatCompletion(data: any, opts: ResponsesOptions): any {
  const respId = randomRespId();
  const choice = data.choices?.[0];
  const assistantMsg = choice?.message || { role: "assistant", content: "", tool_calls: [] };
  const contentText = typeof assistantMsg.content === "string" ? (assistantMsg.content || "") : "";
  const reasoningText = typeof assistantMsg.reasoning_content === "string" ? (assistantMsg.reasoning_content || "") : "";
  const rawToolCalls = Array.isArray(assistantMsg.tool_calls) ? assistantMsg.tool_calls : [];

  // Run the salvager on non-streamed tool calls too — same problems
  // (schema drift, broken JSON, apology text, loops) affect this path.
  const { repaired, dropped, total } = repairToolCalls(rawToolCalls);
  if (dropped.length) bumpSalvageStat("dropped");
  if (repaired.length && repaired.length !== total) {
    console.log(`[TOOL SALVAGE] ${opts.model} (/responses non-stream): ${repaired.length}/${total} tool_calls repaired, ${dropped.length} dropped`);
  }

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
  for (const tc of repaired) {
    const fn = tc.function || tc;
    output.push({
      id: tc.id || randomItemId(),
      type: "function_call",
      status: "completed",
      call_id: randomCallId(),
      name: fn.name || extractNameFromToolId(tc.id) || "unknown",
      arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}),
    });
  }

  const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  const finalOutput: any[] = [];
  if (opts.reasoning && (opts.reasoning.effort || opts.reasoning.summary)) {
    // Include the reasoning summary text if the upstream provided
    // reasoning_content — VS renders it in the reasoning card instead of
    // leaving the card blank.
    const summary = reasoningText ? [{ type: "summary_text", text: reasoningText }] : [];
    finalOutput.push({
      id: randomItemId(),
      type: "reasoning",
      summary,
      encrypted_content: "",
    });
  }
  finalOutput.push(...output);

  const resp = baseResponse(respId, opts.model, opts);
  resp.status = "completed";
  resp.output = finalOutput;
  resp.completed_at = Math.floor(Date.now() / 1000);
  resp.usage = {
    input_tokens: usage.prompt_tokens || 0,
    output_tokens: usage.completion_tokens || 0,
    total_tokens: usage.total_tokens || 0,
    input_tokens_details: { cached_tokens: (usage as any).prompt_tokens_details?.cached_tokens ?? 0 },
    output_tokens_details: { reasoning_tokens: (usage as any).completion_tokens_details?.reasoning_tokens ?? 0 },
  };
  return resp;
}

interface AccState {
  text: string;
  contentStarted: boolean;
  reasoningStarted: boolean;
  reasoningClosed: boolean;
  reasoningText: string;
  messageItemAdded: boolean;
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
  const acc: AccState = { text: "", contentStarted: false, reasoningStarted: false, reasoningClosed: false, reasoningText: "", messageItemAdded: false, toolCalls: {} };

  const createdResp = baseResponse(respId, opts.model, opts);
  yield sseEvent("response.created", { response: createdResp, sequence_number: nextSeq(), type: "response.created" });
  yield sseEvent("response.in_progress", { response: createdResp, sequence_number: nextSeq(), type: "response.in_progress" });

  // Reasoning output item (output_index 0) and message output item
  // (output_index 1) are emitted lazily by handleChatDelta when the
  // corresponding delta first arrives. Eagerly emitting an empty reasoning
  // item and then an empty message item — as the old code did — causes VS
  // to render a blank reasoning card or drop the reasoning text into the
  // assistant message stream when upstreams only send one of the two
  // (e.g. umans-coder streams only reasoning_content, no content).
  const hasReasoning = !!(opts.reasoning && (opts.reasoning.effort || opts.reasoning.summary));
  const reasoningId = hasReasoning ? randomItemId() : null;

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
      for (const chunk of handleChatDelta(evt, acc, messageId, opts.model, reasoningId)) {
        yield chunk;
      }
    }
  }
  if (buffer.trim()) {
    const evt = parseChatCompletionSseLine(buffer);
    if (evt) {
      for (const chunk of handleChatDelta(evt, acc, messageId, opts.model, reasoningId)) {
        yield chunk;
      }
    }
  }

  // ── Close any still-open reasoning item ──
  // If reasoning_content streamed but no assistant content followed, the
  // reasoning item is still open — close it now before finalizing.
  if (acc.reasoningStarted && !acc.reasoningClosed) {
    acc.reasoningClosed = true;
    yield sseEvent("response.reasoning_summary_text.done", {
      output_index: 0,
      item_id: reasoningId,
      summary_index: 0,
      text: acc.reasoningText,
      sequence_number: nextSeq(),
      type: "response.reasoning_summary_text.done",
    });
    yield sseEvent("response.reasoning_summary_part.done", {
      output_index: 0,
      item_id: reasoningId,
      summary_index: 0,
      part: { type: "summary_text", text: acc.reasoningText },
      sequence_number: nextSeq(),
      type: "response.reasoning_summary_part.done",
    });
    yield sseEvent("response.output_item.done", {
      output_index: 0,
      item: { id: reasoningId, type: "reasoning", summary: [{ type: "summary_text", text: acc.reasoningText }] },
      sequence_number: nextSeq(),
      type: "response.output_item.done",
    });
  }

  // Emit content_part.done / output_text.done
  // IMPORTANT: must close the content_part whenever contentStarted is true,
  // even if acc.text is empty. Otherwise VS keeps a streaming block open
  // and the next output_item.done throws
  // "Can not write new content part while streaming block is open".
  if (acc.contentStarted) {
    yield sseEvent("response.output_text.done", { output_index: 1, content_index: 0, item_id: messageId, sequence_number: nextSeq(), type: "response.output_text.done" });
    yield sseEvent("response.content_part.done", { output_index: 1, content_index: 0, item_id: messageId, part: { type: "output_text", text: acc.text, annotations: [] }, sequence_number: nextSeq(), type: "response.content_part.done" });
  }

  // Finalize message item — only if it was actually added (content arrived).
  // Emitting output_item.done for a never-added item confuses VS's streaming
  // state machine and produces empty assistant bubbles.
  if (acc.messageItemAdded) {
    const finalContent = acc.contentStarted ? [{ type: "output_text", text: acc.text, annotations: [] }] : [];
    yield sseEvent("response.output_item.done", { output_index: 1, item: { id: messageId, type: "message", role: "assistant", status: "completed", content: finalContent }, sequence_number: nextSeq(), type: "response.output_item.done" });
  }

  // ── Tool salvager: repair accumulated tool calls before emitting ──
  // Mirrors what /v1/messages and /chat/completions do. Without this, hybrid
  // mode (where VS uses POST /responses) forwards broken tool calls from
  // Agnes/Kimi/umans straight to VS, the tool fails to dispatch, and the
  // agentic turn hangs.
  const toolIndices = Object.keys(acc.toolCalls).map(Number).sort((a, b) => a - b);
  const rawToolCalls = toolIndices.map((idx) => {
    const a = acc.toolCalls[idx];
    return { id: a.id, type: "function", function: { name: a.name, arguments: a.args } };
  });
  const { repaired, dropped, total } = repairToolCalls(rawToolCalls);
  if (dropped.length) bumpSalvageStat("dropped");
  if (repaired.length && repaired.length !== total) {
    console.log(`[TOOL SALVAGE] ${opts.model} (/responses stream): ${repaired.length}/${total} tool_calls repaired, ${dropped.length} dropped`);
  }

  // Apology / loop detection — same gating as the /v1/messages streaming path.
  // `detectToolLoop` needs the conversation history, so opts.messages must be
  // populated by the caller (vs/handler.ts) for this to fire.
  const apology = detectApologyText(acc.text);
  const allDropped = total > 0 && repaired.length === 0;
  const loopCheck = repaired.length
    ? detectToolLoop(opts.messages || [], { name: repaired[0].function?.name || "", arguments: repaired[0].function?.arguments || "{}" })
    : { inLoop: false, count: 0, tool: "", args: "" };
  if ((apology && allDropped) || loopCheck.inLoop) {
    bumpSalvageStat(loopCheck.inLoop ? "loopInjected" : "apologyInjected");
    console.log(`[TOOL SALVAGE] ${opts.model} (/responses stream): ${loopCheck.inLoop ? `loop(${loopCheck.tool}×${loopCheck.count})` : "apology"} → task_complete`);
    // Emit a single task_complete function_call output item so VS finalizes
    // the turn instead of waiting for a broken tool to return.
    // output_index is dynamic: 0 if only reasoning, 1 if reasoning+message or
    // message-only, 2 if both reasoning and message were streamed.
    const tcOutIdx = (acc.reasoningStarted ? 1 : 0) + (acc.messageItemAdded ? 1 : 0);
    const tcCallId = "call_task_complete";
    const tcItemId = randomItemId();
    yield sseEvent("response.output_item.added", {
      output_index: tcOutIdx,
      item: { id: tcItemId, type: "function_call", status: "in_progress", call_id: tcCallId, name: "task_complete", arguments: "" },
      sequence_number: nextSeq(),
      type: "response.output_item.added",
    });
    yield sseEvent("response.function_call_arguments.delta", {
      output_index: tcOutIdx,
      call_id: tcCallId,
      delta: "{}",
      sequence_number: nextSeq(),
      type: "response.function_call_arguments.delta",
    });
    yield sseEvent("response.function_call_arguments.done", {
      output_index: tcOutIdx,
      call_id: tcCallId,
      arguments: "{}",
      sequence_number: nextSeq(),
      type: "response.function_call_arguments.done",
    });
    yield sseEvent("response.output_item.done", {
      output_index: tcOutIdx,
      item: { id: tcItemId, type: "function_call", status: "completed", call_id: tcCallId, name: "task_complete", arguments: "{}" },
      sequence_number: nextSeq(),
      type: "response.output_item.done",
    });
    // response.completed with just the message + task_complete
    createdResp.status = "completed";
    createdResp.completed_at = Math.floor(Date.now() / 1000);
    createdResp.output = [];
    if (acc.reasoningStarted && reasoningId) {
      createdResp.output.push({ id: reasoningId, type: "reasoning", summary: [{ type: "summary_text", text: acc.reasoningText }], encrypted_content: "" });
    }
    if (acc.contentStarted) {
      createdResp.output.push({ id: messageId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: acc.text, annotations: [] }] });
    }
    createdResp.output.push({ id: tcItemId, type: "function_call", status: "completed", call_id: tcCallId, name: "task_complete", arguments: "{}" });
    createdResp.usage = {
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: acc.text.length,
      output_tokens_details: { reasoning_tokens: acc.reasoningText.length },
      total_tokens: acc.text.length,
    };
    const copilotUsageTc = {
      token_details: [
        { batch_size: 1000000, cost_per_batch: 25000000000, token_count: 0, token_type: "input" },
        { batch_size: 1000000, cost_per_batch: 2000000000, token_count: 0, token_type: "cache_read" },
        { batch_size: 1000000, cost_per_batch: 200000000000, token_count: acc.text.length, token_type: "output" },
      ],
      total_nano_aiu: acc.text.length * 100000,
    };
    yield sseEvent("response.completed", { copilot_usage: copilotUsageTc, response: createdResp, sequence_number: nextSeq(), type: "response.completed" });
    return;
  }

  // Emit repaired tool calls as finalized output items.
  // output_index is dynamic based on which optional items preceded them:
  //   reasoning only  -> tools start at 1
  //   message only    -> tools start at 1
  //   reasoning+msg   -> tools start at 2
  //   neither         -> tools start at 0
  const toolBaseIdx = (acc.reasoningStarted ? 1 : 0) + (acc.messageItemAdded ? 1 : 0);
  for (let i = 0; i < repaired.length; i++) {
    const tc = repaired[i];
    const outIdx = toolBaseIdx + i;
    const callId = randomCallId();
    const itemId = tc.id || randomItemId();
    const fn = tc.function || tc;
    const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {});
    yield sseEvent("response.output_item.added", {
      output_index: outIdx,
      item: { id: itemId, type: "function_call", status: "in_progress", call_id: callId, name: fn.name || "unknown", arguments: "" },
      sequence_number: nextSeq(),
      type: "response.output_item.added",
    });
    yield sseEvent("response.function_call_arguments.delta", {
      output_index: outIdx,
      call_id: callId,
      delta: args,
      sequence_number: nextSeq(),
      type: "response.function_call_arguments.delta",
    });
    yield sseEvent("response.function_call_arguments.done", {
      output_index: outIdx,
      call_id: callId,
      arguments: args,
      sequence_number: nextSeq(),
      type: "response.function_call_arguments.done",
    });
    yield sseEvent("response.output_item.done", {
      output_index: outIdx,
      item: { id: itemId, type: "function_call", status: "completed", call_id: callId, name: fn.name || "unknown", arguments: args },
      sequence_number: nextSeq(),
      type: "response.output_item.done",
    });
  }

  // Final response.completed uses the SAME base response object so all envelope fields match
  createdResp.status = "completed";
  createdResp.completed_at = Math.floor(Date.now() / 1000);
  createdResp.output = [];
  if (acc.reasoningStarted && reasoningId) {
    createdResp.output.push({ id: reasoningId, type: "reasoning", summary: [{ type: "summary_text", text: acc.reasoningText }], encrypted_content: "" });
  }
  if (acc.contentStarted) {
    createdResp.output.push({ id: messageId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: acc.text, annotations: [] }] });
  }
  // Use the salvager's repaired tool calls in the final response envelope
  // so VS's aggregated state matches the streamed output items above.
  for (let i = 0; i < repaired.length; i++) {
    const tc = repaired[i];
    const fn = tc.function || tc;
    const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {});
    createdResp.output.push({ id: tc.id || randomItemId(), type: "function_call", status: "completed", call_id: randomCallId(), name: fn.name || "unknown", arguments: args });
  }
  createdResp.usage = {
    input_tokens: 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: acc.text.length,
    output_tokens_details: { reasoning_tokens: acc.reasoningText.length },
    total_tokens: acc.text.length,
  };
  // VS expects copilot_usage at the top level of response.completed (sibling
  // to response). Without it, ChatCoreWithResponsesAPIAsync throws
  // NullReferenceException when finalizing the response.
  const copilotUsage = {
    token_details: [
      { batch_size: 1000000, cost_per_batch: 25000000000, token_count: 0, token_type: "input" },
      { batch_size: 1000000, cost_per_batch: 2000000000, token_count: 0, token_type: "cache_read" },
      { batch_size: 1000000, cost_per_batch: 200000000000, token_count: acc.text.length, token_type: "output" },
    ],
    total_nano_aiu: acc.text.length * 100000,
  };
  yield sseEvent("response.completed", { copilot_usage: copilotUsage, response: createdResp, sequence_number: nextSeq(), type: "response.completed" });
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
      // If the reasoning item has summary text, stream it via the
      // reasoning_summary_part events (matches real GitHub /responses format).
      const summaryParts = Array.isArray(item.summary) ? item.summary : [];
      for (let sIdx = 0; sIdx < summaryParts.length; sIdx++) {
        const sp = summaryParts[sIdx];
        const sText = (sp && typeof sp.text === "string") ? sp.text : "";
        yield sseEvent("response.reasoning_summary_part.added", {
          output_index: outputIndex,
          item_id: item.id,
          summary_index: sIdx,
          part: { type: "summary_text", text: "" },
          sequence_number: nextSeq(),
          type: "response.reasoning_summary_part.added",
        });
        if (sText) {
          const words = sText.split(/(?=\s)/g);
          for (const word of words) {
            yield sseEvent("response.reasoning_summary_text.delta", {
              output_index: outputIndex,
              item_id: item.id,
              summary_index: sIdx,
              delta: word,
              obfuscation: "",
              sequence_number: nextSeq(),
              type: "response.reasoning_summary_text.delta",
            });
          }
        }
        yield sseEvent("response.reasoning_summary_text.done", {
          output_index: outputIndex,
          item_id: item.id,
          summary_index: sIdx,
          text: sText,
          sequence_number: nextSeq(),
          type: "response.reasoning_summary_text.done",
        });
        yield sseEvent("response.reasoning_summary_part.done", {
          output_index: outputIndex,
          item_id: item.id,
          summary_index: sIdx,
          part: { type: "summary_text", text: sText },
          sequence_number: nextSeq(),
          type: "response.reasoning_summary_part.done",
        });
      }
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

  const copilotUsage = {
    token_details: [
      { batch_size: 1000000, cost_per_batch: 25000000000, token_count: 0, token_type: "input" },
      { batch_size: 1000000, cost_per_batch: 2000000000, token_count: 0, token_type: "cache_read" },
      { batch_size: 1000000, cost_per_batch: 200000000000, token_count: 0, token_type: "output" },
    ],
    total_nano_aiu: 0,
  };
  yield sseEvent("response.completed", { copilot_usage: copilotUsage, response: resp, sequence_number: nextSeq(), type: "response.completed" });
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

function* handleChatDelta(d: any, acc: AccState, messageId: string, model: string, reasoningId: string | null): Generator<string> {
  const delta = d.choices?.[0]?.delta;
  if (!delta) return;

  // ── Reasoning content: emit as a dedicated reasoning output item with
  //    response.reasoning_summary_part.added / .delta / .done events, matching
  //    real GitHub /responses streaming format. Previously this leaked
  //    "The user said..." reasoning into the assistant text stream
  //    (response.output_text.delta), which VS rendered as normal chat output.
  if (delta.reasoning_content && reasoningId) {
    if (!acc.reasoningStarted) {
      acc.reasoningStarted = true;
      yield sseEvent("response.output_item.added", {
        output_index: 0,
        item: { id: reasoningId, type: "reasoning", summary: [] },
        sequence_number: nextSeq(),
        type: "response.output_item.added",
      });
      yield sseEvent("response.reasoning_summary_part.added", {
        output_index: 0,
        item_id: reasoningId,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
        sequence_number: nextSeq(),
        type: "response.reasoning_summary_part.added",
      });
    }
    acc.reasoningText += delta.reasoning_content;
    yield sseEvent("response.reasoning_summary_text.delta", {
      output_index: 0,
      item_id: reasoningId,
      summary_index: 0,
      delta: delta.reasoning_content,
      obfuscation: "",
      sequence_number: nextSeq(),
      type: "response.reasoning_summary_text.delta",
    });
  }

  // ── Assistant text content: emit as response.output_text.delta inside a
  //    message output item at output_index 1 (after reasoning at index 0).
  if (delta.content) {
    // If reasoning was streamed but not yet closed, close it NOW — before
    // the new message output_item.added. VS requires the reasoning item to
    // be done before a new output_item starts; emitting them out of order
    // triggers "Can not write new content part while streaming block is open".
    if (acc.reasoningStarted && !acc.reasoningClosed) {
      acc.reasoningClosed = true;
      yield sseEvent("response.reasoning_summary_text.done", {
        output_index: 0,
        item_id: reasoningId,
        summary_index: 0,
        text: acc.reasoningText,
        sequence_number: nextSeq(),
        type: "response.reasoning_summary_text.done",
      });
      yield sseEvent("response.reasoning_summary_part.done", {
        output_index: 0,
        item_id: reasoningId,
        summary_index: 0,
        part: { type: "summary_text", text: acc.reasoningText },
        sequence_number: nextSeq(),
        type: "response.reasoning_summary_part.done",
      });
      yield sseEvent("response.output_item.done", {
        output_index: 0,
        item: { id: reasoningId, type: "reasoning", summary: [{ type: "summary_text", text: acc.reasoningText }] },
        sequence_number: nextSeq(),
        type: "response.output_item.done",
      });
    }
    if (!acc.messageItemAdded) {
      acc.messageItemAdded = true;
      yield sseEvent("response.output_item.added", { output_index: 1, item: { id: messageId, type: "message", status: "in_progress", role: "assistant", content: [] }, sequence_number: nextSeq(), type: "response.output_item.added" });
    }
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

  // Buffer tool_calls as they arrive; the salvager runs once the stream
  // completes (in streamChatCompletionToResponses) and emits the repaired
  // output items afterwards. Emitting them inline here would bypass schema
  // repair / apology / loop detection and forward broken calls to VS —
  // which is exactly the bug that made hybrid-mode /responses hang.
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      const idx = typeof tc.index === "number" ? tc.index : 0;
      if (!acc.toolCalls[idx]) {
        acc.toolCalls[idx] = { id: tc.id || randomItemId(), name: "", args: "", callId: randomCallId(), emitted: false };
      }
      const t = acc.toolCalls[idx];
      if (!t.name) {
        const recovered = tc.function?.name || extractNameFromToolId(tc.id);
        if (recovered) t.name = recovered;
      }
      if (tc.function?.arguments) t.args += tc.function.arguments;
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
