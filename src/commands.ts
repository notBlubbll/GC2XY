// Record & Replay - capture and replay HTTP flows
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as readline from "node:readline";
import { spawn } from "node:child_process";
import { isDebug } from "./split-console.ts";
import { getProjectRoot } from "./shared.ts";

const RECORDINGS_DIR = join(getProjectRoot(), ".recordings");
mkdirSync(RECORDINGS_DIR, { recursive: true });

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

interface RecordedResponse {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  body: string | null;
}

interface RecordedFlow {
  id: string;
  name: string;
  timestamp: string;
  entries: Array<{
    request: RecordedRequest;
    response: RecordedResponse;
  }>;
}

let currentFlow: RecordedFlow | null = null;
let isRecording = false;
let isReplaying = false;
let loadedFlow: RecordedFlow | null = null;
let replayIndex = 0;

let _rl: readline.Interface | null = null;
function getRl(): readline.Interface {
  if (!_rl) _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return _rl;
}

function ask(query: string): Promise<string> {
  return new Promise((resolve) => getRl().question(query, resolve));
}

function listRecordings(): string[] {
  try {
    return readdirSync(RECORDINGS_DIR).filter(f => f.endsWith(".json")).sort().reverse();
  } catch { return []; }
}

async function saveFlow(flow: RecordedFlow) {
  const path = join(RECORDINGS_DIR, `${flow.id}.json`);
  writeFileSync(path, JSON.stringify(flow, null, 2));
  if (isDebug()) console.log(`[RECORD] Saved flow to ${path}`);
}

function loadFlow(id: string): RecordedFlow | null {
  const path = join(RECORDINGS_DIR, `${id}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function matchUrl(pattern: string, url: string): boolean {
  if (pattern === url) return true;
  if (url.startsWith(pattern)) return true;
  try {
    const regex = new RegExp(pattern);
    return regex.test(url);
  } catch { return false; }
}

// Start recording a new flow
async function startRecording(name?: string) {
  const modeStr = process.env.gc2xy_MODE || "mock";
  const flowName = name || `flow-${Date.now()}-${modeStr}`;
  currentFlow = {
    id: flowName.replace(/[^a-zA-Z0-9_-]/g, "_"),
    name: flowName,
    timestamp: new Date().toISOString(),
    entries: [],
  };
  isRecording = true;
  isReplaying = false;
  replayIndex = 0;
  if (isDebug()) console.log(`[RECORD] Started recording: ${currentFlow.id}`);
  if (isDebug()) console.log(`[RECORD] All matching traffic will be captured`);
}

// Stop recording (interactive — asks for name via readline)
async function stopRecording() {
  if (!currentFlow || !isRecording) return;
  isRecording = false;
  if (isDebug()) console.log(`[RECORD] Stopped recording. ${currentFlow.entries.length} entries captured.`);
  await saveFlow(currentFlow);
  const name = await ask(`[RECORD] Name this recording [${currentFlow.name}] > `);
  if (name) currentFlow.name = name;
  currentFlow.id = currentFlow.name.replace(/[^a-zA-Z0-9_-]/g, "_");
  await saveFlow(currentFlow);
  currentFlow = null;
}

// Stop recording (non-interactive — uses auto-generated name, no prompt)
async function stopRecordingAuto() {
  if (!currentFlow || !isRecording) return;
  isRecording = false;
  if (isDebug()) console.log(`[RECORD] Stopped recording. ${currentFlow.entries.length} entries captured.`);
  await saveFlow(currentFlow);
  currentFlow = null;
}

// Load a recording for replay
async function loadRecording(id: string) {
  const flow = loadFlow(id);
  if (!flow) {
    if (isDebug()) console.log(`[REPLAY] Recording not found: ${id}`);
    return false;
  }
  loadedFlow = flow;
  isReplaying = true;
  isRecording = false;
  replayIndex = 0;
  if (isDebug()) console.log(`[REPLAY] Loaded "${flow.name}" with ${flow.entries.length} entries`);
  return true;
}

// Stop replay
function stopReplay() {
  isReplaying = false;
  loadedFlow = null;
  replayIndex = 0;
  if (isDebug()) console.log("[REPLAY] Stopped replay");
}

// Check if a request matches a recorded entry and return the recorded response
function tryReplay(method: string, url: string): RecordedResponse | null {
  if (!isReplaying || !loadedFlow) return null;

  for (const entry of loadedFlow.entries) {
    if (entry.request.method === method && (entry.request.url === url || url.startsWith(entry.request.url))) {
      if (isDebug()) console.log(`[REPLAY] Matched: ${method} ${url}`);
      return entry.response;
    }
  }
  return null;
}

// Record a request/response pair
function recordEntry(request: RecordedRequest, response: RecordedResponse) {
  if (!isRecording || !currentFlow) return;
  currentFlow.entries.push({ request, response });
  if (isDebug()) console.log(`[RECORD] Captured: ${request.method} ${request.url} -> ${response.statusCode}`);
}

// Check env var for auto-record
if (process.env.RECORD_MODE === "1") {
  const name = `auto-record-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  currentFlow = {
    id: name,
    name,
    timestamp: new Date().toISOString(),
    entries: [],
  };
  isRecording = true;
  if (isDebug()) console.log(`[RECORD] Auto-recording started: ${name}`);
}

// Interactive console
async function showConsole() {
  console.log("\n" + "=".repeat(50));
  console.log("RECORD/REPLAY CONSOLE");
  console.log("=".repeat(50));

  while (true) {
    const status = isRecording ? "RECORDING" : isReplaying ? "REPLAYING" : "IDLE";
    const cmd = await ask(`\n[${status}] > `);
    const parts = cmd.trim().split(/\s+/);
    const verb = parts[0].toLowerCase();

    switch (verb) {
      case "record":
      case "r": {
        const name = parts.slice(1).join(" ");
        await startRecording(name || undefined);
        break;
      }

      case "stop":
      case "s": {
        if (isRecording) await stopRecording();
        if (isReplaying) stopReplay();
        break;
      }

      case "replay":
      case "p": {
        const recordings = listRecordings();
        if (recordings.length === 0) {
          console.log("[REPLAY] No recordings found");
          break;
        }
        console.log("\nAvailable recordings:");
        recordings.forEach((f, i) => {
          const flow = loadFlow(f.replace(".json", ""));
          if (flow) console.log(`  ${i+1}. ${flow.name} (${flow.entries.length} entries)`);
        });
        if (parts[1]) {
          const idx = parseInt(parts[1]) - 1;
          if (idx >= 0 && idx < recordings.length) {
            await loadRecording(recordings[idx].replace(".json", ""));
          }
        }
        break;
      }

      case "list":
      case "l": {
        const recordings = listRecordings();
        if (recordings.length === 0) {
          console.log("No recordings");
        } else {
          recordings.forEach((f, i) => {
            const flow = loadFlow(f.replace(".json", ""));
            if (flow) console.log(`  ${i+1}. ${flow.name} (${flow.entries.length} entries)`);
          });
        }
        break;
      }

      case "delete":
      case "d": {
        const idx = parseInt(parts[1]) - 1;
        const recordings = listRecordings();
        if (idx >= 0 && idx < recordings.length) {
          // delete
        }
        break;
      }

      case "help":
      case "h":
        console.log(`
Commands:
  record [name]  - Start recording a new flow
  stop           - Stop recording/replaying
  replay [n]     - Load a recording for replay
  list           - List all recordings
  restart        - Restart the proxy
  help           - Show this help
`);
        break;

      case "restart":
        console.log("[RESTART] Restarting proxy...");
        getRl().close();
        try {
          const exe = process.execPath;
          const wd = process.cwd();
          const args = process.argv.slice(1).join(" ");
          const cmd = `start "gc2xy - Mock" /D "${wd}" cmd /c "${exe}" ${args}`;
          if (typeof Bun !== 'undefined') {
            Bun.spawn(["cmd", "/c", cmd], { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).unref();
          } else {
            spawn("cmd", ["/c", cmd], { detached: true, stdio: "ignore", windowsHide: true }).unref();
          }
        } catch (e) {
          console.log("[RESTART] Error:", e.message);
        }
        setTimeout(() => process.exit(0), 1000);
        return;

      case "quit":
      case "q":
      case "exit":
        return;

      default:
        if (cmd) console.log("Unknown command. Type 'help'");
    }
  }
}

export {
  startRecording,
  stopRecording,
  stopRecordingAuto,
  loadRecording,
  stopReplay,
  tryReplay,
  recordEntry,
  showConsole,
  isRecording,
  isReplaying,
  currentFlow,
  RECORDINGS_DIR,
};
