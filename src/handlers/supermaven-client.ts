import { getProjectRoot } from "../shared.ts";
import https from "node:https";
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, chmodSync, writeFileSync, readFileSync, copyFileSync, readdirSync, unlinkSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { platform, arch, homedir } from "node:os";
import { createWriteStream } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let _supermavenEnabled = false;
export function isSupermavenEnabled(): boolean { return _supermavenEnabled; }
export function setSupermavenEnabled(v: boolean) { _supermavenEnabled = v; }
export function isSupermavenReady(): boolean { return !!_instance?.initialized; }

export class SupermavenClient {
  binaryPath: string | null = null;
  binaryProcess: ReturnType<typeof spawn> | null = null;
  initialized = false;
  stateId = 0;
  stateMap = new Map<string, { completion: any[]; resolve: () => void }>();
  buffer = "";
  cacheDir = join(getProjectRoot(), ".cache");
  versionFile = join(this.cacheDir, "supermaven-version.json");

  constructor() {
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try { mkdirSync(this.cacheDir, { recursive: true }); } catch {}
    await this.updateBinary();
    this.binaryPath = this.findBinary();

    if (!this.binaryPath) {
      console.log("[Supermaven] Binary not found");
      return;
    }

    console.log("[Supermaven] Using binary:", this.binaryPath);
    this.startBinary();
    this.initialized = true;
    console.log("[Supermaven] Ready");
  }

  getPlatform(): string {
    const p = platform();
    if (p === "win32") return "windows";
    if (p === "darwin") return "darwin";
    return "linux";
  }

  getArch(): string {
    const a = arch();
    if (a === "arm64" || a === "aarch64") return "aarch64";
    return "x86_64";
  }

  getBinaryPath(): string {
    const ext = this.getPlatform() === "windows" ? ".exe" : "";
    return join(this.cacheDir, `supermaven-bin${ext}`);
  }

  getVersionInfo(): { version: number } {
    try {
      if (existsSync(this.versionFile)) return JSON.parse(readFileSync(this.versionFile, "utf-8"));
    } catch {}
    return { version: 0 };
  }

  saveVersionInfo(info: any): void {
    try { writeFileSync(this.versionFile, JSON.stringify(info, null, 2)); } catch {}
  }

  async updateBinary(): Promise<void> {
    console.log("[Supermaven] Checking for updates...");
    const cachedPath = this.getBinaryPath();

    if (existsSync(cachedPath)) {
      console.log("[Supermaven] Binary exists");
      return;
    }

    console.log("[Supermaven] Downloading from marketplace...");
    try {
      const { execSync } = await import("node:child_process");
      const vsixPath = join(this.cacheDir, "supermaven.vsix");
      const zipPath = join(this.cacheDir, "supermaven.zip");

      execSync(`powershell -command "Invoke-WebRequest -Uri 'https://marketplace.visualstudio.com/_apis/public/gallery/publishers/supermaven/vsextensions/supermaven/1.1.12/vspackage' -OutFile '${vsixPath}'"`, { encoding: "utf-8", timeout: 60000 });

      if (existsSync(zipPath)) unlinkSync(zipPath);
      renameSync(vsixPath, zipPath);

      const tmpDir = join(this.cacheDir, "tmp-extract");
      mkdirSync(tmpDir, { recursive: true });
      execSync(`powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tmpDir}' -Force"`, { encoding: "utf-8", timeout: 30000 });

      const findAgent = (dir: string): string | null => {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            const result = findAgent(fullPath);
            if (result) return result;
          } else if (entry.name.includes("sm-agent")) {
            return fullPath;
          }
        }
        return null;
      };

      const agentPath = findAgent(tmpDir);
      if (agentPath) {
        mkdirSync(dirname(cachedPath), { recursive: true });
        copyFileSync(agentPath, cachedPath);
        console.log("[Supermaven] Binary downloaded and extracted");
      }

      try { unlinkSync(zipPath); } catch {}
      try { execSync(`powershell -command "Remove-Item -Path '${tmpDir}' -Recurse -Force"`, { encoding: "utf-8" }); } catch {}

    } catch (e: any) {
      console.log("[Supermaven] Download failed:", e.message);
      const vscodeExtDir = join(homedir(), ".vscode", "extensions");
      if (existsSync(vscodeExtDir)) {
        try {
          const dirs = readdirSync(vscodeExtDir).filter(d => d.startsWith("supermaven.supermaven"));
          for (const dir of dirs) {
            const extPath = join(vscodeExtDir, dir);
            const agentPath = join(extPath, "bin", "win32-x64", "sm-agent.exe");
            if (existsSync(agentPath)) {
              mkdirSync(dirname(cachedPath), { recursive: true });
              copyFileSync(agentPath, cachedPath);
              console.log("[Supermaven] Binary copied from VSCode extension");
              return;
            }
          }
        } catch {}
      }
      console.log("[Supermaven] No binary found");
    }
  }

  findBinary(): string | null {
    console.log("[Supermaven] Looking for binary...");

    const cachedPath = this.getBinaryPath();
    if (existsSync(cachedPath)) {
      console.log("[Supermaven] Found cached binary");
      return cachedPath;
    }

    console.log("[Supermaven] No cached binary, searching VSCode extensions...");
    const vscodeExtDir = join(homedir(), ".vscode", "extensions");
    if (existsSync(vscodeExtDir)) {
      try {
        const dirs = readdirSync(vscodeExtDir).filter(d => d.startsWith("supermaven.supermaven"));
        console.log(`[Supermaven] Found ${dirs.length} Supermaven extension(s)`);
        for (const dir of dirs) {
          const extPath = join(vscodeExtDir, dir);
          const binDirs = ["bin/win32-x64", "bin/linux-x64", "bin/darwin-arm64", "bin/darwin-x64"];
          for (const binDir of binDirs) {
            const ext = this.getPlatform() === "windows" ? ".exe" : "";
            const agentPath = join(extPath, binDir, `sm-agent${ext}`);
            if (existsSync(agentPath)) {
              mkdirSync(dirname(cachedPath), { recursive: true });
              copyFileSync(agentPath, cachedPath);
              console.log("[Supermaven] Copied binary from VSCode extension to cache");
              return cachedPath;
            }
          }
        }
      } catch (e: any) {
        console.log("[Supermaven] Error searching extensions:", e.message);
      }
    }

    console.log("[Supermaven] No binary found");
    return null;
  }

  startBinary(): void {
    if (!this.binaryPath || !existsSync(this.binaryPath)) {
      throw new Error("Binary not found");
    }

    console.log("[Supermaven] Starting binary...");
    this.binaryProcess = spawn(this.binaryPath, ["stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.binaryProcess.stdout?.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    this.binaryProcess.stderr?.on("data", (_data: Buffer) => {});

    this.binaryProcess.on("exit", (code: number) => {
      console.log(`[Supermaven] Binary exited: ${code}`);
      this.binaryProcess = null;
      this.initialized = false;
    });

    this.sendJson({ kind: "greeting", allowGitignore: false });
    this.sendJson({ kind: "use_free_version" });
  }

  processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("SM-MESSAGE ")) {
        try {
          const msg = JSON.parse(line.slice(11));
          this.processMessage(msg);
        } catch {}
      }
    }
  }

  processMessage(msg: any): void {
    if (msg.kind === "response") {
      const state = this.stateMap.get(msg.stateId);
      if (state) {
        state.completion = msg.items || [];
        if (state.resolve) state.resolve();
      }
    } else if (msg.kind === "service_tier") {
      console.log(`[Supermaven] Tier: ${msg.display || msg.service_tier}`);
    }
  }

  sendJson(msg: any): void {
    if (this.binaryProcess?.stdin) {
      this.binaryProcess.stdin.write(JSON.stringify(msg) + "\n");
    }
  }

  async getCompletion(documentText: string, cursorOffset: number, filePath = "untitled"): Promise<string> {
    if (!this.binaryProcess) {
      await this.initialize();
    }

    if (!this.binaryProcess) return "";

    this.stateId++;
    const stateIdStr = this.stateId.toString();

    const completionPromise = new Promise<void>((resolve) => {
      this.stateMap.set(stateIdStr, { completion: [], resolve });
      setTimeout(() => {
        const state = this.stateMap.get(stateIdStr);
        if (state?.resolve) state.resolve();
      }, 2000);
    });

    this.sendJson({
      kind: "state_update",
      newId: stateIdStr,
      updates: [
        { kind: "file_update", path: filePath, content: documentText },
        { kind: "cursor_update", path: filePath, offset: cursorOffset },
      ],
    });

    await completionPromise;

    const state = this.stateMap.get(stateIdStr);
    this.stateMap.delete(stateIdStr);

    if (!state?.completion) return "";

    let text = "";
    for (const item of state.completion) {
      if (item.kind === "text") text += item.text;
    }

    console.log(`[Supermaven] Completion (${state.completion.length} items): "${text.substring(0, 100)}"`);
    return text;
  }

  async codeComplete(prompt: string): Promise<string> {
    await this.initialize();
    console.log(`[Supermaven] codeComplete prompt (${prompt.length} chars): "${prompt.substring(0, 80)}..."`);
    const completion = await this.getCompletion(prompt, prompt.length);
    console.log(`[Supermaven] codeComplete result: "${(completion || "").substring(0, 80)}"`);
    return completion || "No completion available";
  }

  async chatCompletion(prompt: string, options: { model?: string } = {}): Promise<string> {
    await this.initialize();
    if (!this.binaryPath || !this.binaryProcess) {
      throw new Error("Supermaven sm-agent binary not available.");
    }
    console.log(`[Supermaven] chatCompletion prompt (${prompt.length} chars): "${prompt.substring(0, 80)}..."`);
    const completion = await this.getCompletion(prompt, prompt.length);
    console.log(`[Supermaven] chatCompletion result: "${(completion || "").substring(0, 80)}"`);
    return completion || "";
  }

  cleanup(): void {
    if (this.binaryProcess) {
      this.binaryProcess.kill();
      this.binaryProcess = null;
    }
    this.initialized = false;
  }
}

let _instance: SupermavenClient | null = null;

export function getSupermavenClient(): SupermavenClient {
  if (!_instance) _instance = new SupermavenClient();
  return _instance;
}

export async function initSupermaven(): Promise<void> {
  const client = getSupermavenClient();
  await client.initialize();
}

export async function supermavenCodeComplete(prompt: string): Promise<string> {
  const client = getSupermavenClient();
  return client.codeComplete(prompt);
}

// New: simple chat via the Supermaven sm-agent binary. The agent
// is not a real chat model — it performs completion on the whole
// conversation-turn text. We still expose it as a test-chat option.
export async function supermavenChatComplete(prompt: string, options: { model?: string } = {}): Promise<string> {
  const client = getSupermavenClient();
  return client.chatCompletion(prompt, options);
}

export function getSupermavenStatus(): { enabled: boolean; initialized: boolean; binaryPath: string | null } {
  if (!_instance) return { enabled: false, initialized: false, binaryPath: null };
  return {
    enabled: _supermavenEnabled,
    initialized: _instance.initialized,
    binaryPath: _instance.binaryPath,
  };
}
