import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getProjectRoot } from "./shared.ts";

export interface StreamLogEntry {
  ts: string;
  endpoint: string;
  model: string;
  resolved?: string;
  status: number;
  stream: boolean;
  elapsedMs?: number;
  content: string;
  reasoning?: string;
  toolCalls?: { id: string; name: string; args: string }[];
  finishReason?: string;
  usage?: any;
  salvager?: { repaired: number; dropped: number; apologyInjected: boolean; loopInjected: boolean };
  error?: string;
}

const LOG_DIR = join(getProjectRoot(), ".proxy-logs");
const LOG_PATH = join(LOG_DIR, "streaming-responses.log");
let _initialized = false;

function ensureLogDir() {
  if (_initialized) return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    _initialized = true;
  } catch {}
}

export function logStreamResponse(entry: StreamLogEntry): void {
  try {
    ensureLogDir();
    const line = JSON.stringify(entry) + "\n";
    appendFileSync(LOG_PATH, line);
  } catch {}
}

export class StreamResponseLogger {
  private endpoint: string;
  private model: string;
  private resolved: string;
  private status: number;
  private startTime: number;
  private content = "";
  private reasoning = "";
  private toolCalls: Record<number, { id: string; name: string; args: string }> = {};
  private finishReason = "";
  private usage: any = null;
  private error: string | undefined;

  constructor(opts: { endpoint: string; model: string; resolved?: string; status?: number }) {
    this.endpoint = opts.endpoint;
    this.model = opts.model;
    this.resolved = opts.resolved || opts.model;
    this.status = opts.status ?? 200;
    this.startTime = Date.now();
  }

  addContent(text: string): void {
    this.content += text;
  }

  addReasoning(text: string): void {
    this.reasoning += text;
  }

  addToolCall(idx: number, id: string, name: string, argsDelta: string): void {
    if (!this.toolCalls[idx]) this.toolCalls[idx] = { id: id || "", name: "", args: "" };
    if (id) this.toolCalls[idx].id = id;
    // Name is set-once: LLMs send the full tool name in every delta chunk, so
    // appending would corrupt it to "foofoofoo". Only set if empty.
    if (name && !this.toolCalls[idx].name) this.toolCalls[idx].name = name;
    if (argsDelta) this.toolCalls[idx].args += argsDelta;
  }

  setFinishReason(reason: string): void {
    this.finishReason = reason;
  }

  setUsage(usage: any): void {
    this.usage = usage;
  }

  setError(msg: string): void {
    this.error = msg;
  }

  flush(salvager?: { repaired: number; dropped: number; apologyInjected: boolean; loopInjected: boolean }): void {
    const tcArr = Object.keys(this.toolCalls).length
      ? Object.values(this.toolCalls).map(t => ({ id: t.id, name: t.name, args: t.args }))
      : undefined;
    const entry: StreamLogEntry = {
      ts: new Date().toISOString(),
      endpoint: this.endpoint,
      model: this.model,
      resolved: this.resolved,
      status: this.status,
      stream: true,
      elapsedMs: Date.now() - this.startTime,
      content: this.content,
      reasoning: this.reasoning || undefined,
      toolCalls: tcArr,
      finishReason: this.finishReason || undefined,
      usage: this.usage || undefined,
      salvager,
      error: this.error,
    };
    logStreamResponse(entry);
  }
}
