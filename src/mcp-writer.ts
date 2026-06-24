// SSMS Copilot MCP config patcher — discovers all SSMS Copilot MCP configs on
// fixed drives and flips SQLtools__ExecutionMode from READ_ONLY to READ_WRITE
// so the agent can execute CREATE/ALTER/INSERT/UPDATE/DELETE (not just read).
//
// Controlled by .config/config.json `MCP_WRITE` field (default: true).
// Set MCP_WRITE=false to disable. Also honors process.env.MCP_WRITE=0/false.

import { existsSync, readFileSync, writeFileSync, readdirSync, copyFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { readJsonSync, getProjectRoot } from "./shared.ts";

const SSMS_MCP_REL = join("Common7", "IDE", "Extensions", "Microsoft", "SSMS.CopilotUiTools", "McpServer");
const MCP_JSON = "mcp.json";
const APPSETTINGS_JSON = "appsettings.json";
const ENV_KEY = "SQLtools__ExecutionMode";
const TARGET_VALUE = "READ_WRITE";
const SOURCE_VALUE = "READ_ONLY";

export interface McpPatchResult {
  path: string;
  action: "patched" | "already" | "skipped" | "error";
  message?: string;
}

function isMcpWriteEnabled(): boolean {
  const envVal = process.env.MCP_WRITE;
  if (envVal !== undefined) {
    const v = envVal.toLowerCase().trim();
    if (v === "0" || v === "false" || v === "no" || v === "off") return false;
    if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  }
  try {
    const p = join(getProjectRoot(), ".config", "config.json");
    if (existsSync(p)) {
      const c = readJsonSync(p);
      if (c && typeof c.MCP_WRITE === "boolean") return c.MCP_WRITE;
    }
  } catch {}
  return true;
}

function enumerateFixedDrives(): string[] {
  const drives: string[] = [];
  for (let code = 67; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    const root = `${letter}:\\`;
    try { if (existsSync(root)) drives.push(letter); } catch {}
  }
  return drives;
}

function findSsmsInstallDirs(drive: string): string[] {
  const results: string[] = [];
  const roots = [
    join(`${drive}:\\`, "Program Files"),
    join(`${drive}:\\`, "Program Files (x86)"),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: string[] = [];
    try { entries = readdirSync(root); } catch { continue; }
    for (const entry of entries) {
      if (/^Microsoft SQL Server Management Studio/i.test(entry)) {
        results.push(join(root, entry));
      }
    }
  }
  return results;
}

function findMcpJsonFiles(ssmsDir: string): string[] {
  const results: string[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(ssmsDir); } catch { return results; }
  for (const entry of entries) {
    const sub = join(ssmsDir, entry);
    try { if (!statSync(sub).isDirectory()) continue; } catch { continue; }
    const mcpDir = join(sub, SSMS_MCP_REL);
    if (!existsSync(mcpDir)) continue;
    const mcpJson = join(mcpDir, MCP_JSON);
    if (existsSync(mcpJson)) results.push(mcpJson);
    const appsettings = join(mcpDir, APPSETTINGS_JSON);
    if (existsSync(appsettings) && results.indexOf(appsettings) === -1) results.push(appsettings);
  }
  return results;
}

export function discoverSsmsMcpConfigs(): string[] {
  const found: string[] = [];
  for (const drv of enumerateFixedDrives()) {
    for (const ssmsDir of findSsmsInstallDirs(drv)) {
      for (const mcp of findMcpJsonFiles(ssmsDir)) {
        if (found.indexOf(mcp) === -1) found.push(mcp);
      }
    }
  }
  return found;
}

export function patchSsmsMcpConfig(filePath: string): McpPatchResult {
  try {
    if (!existsSync(filePath)) return { path: filePath, action: "error", message: "not found" };
    const raw = readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
    const cfg = JSON.parse(raw);
    const fname = filePath.split(/[/\\]/).pop() || "";
    let touched = false;

    if (fname === APPSETTINGS_JSON) {
      const em = cfg?.SqlTools?.ExecutionMode;
      if (em === SOURCE_VALUE) { cfg.SqlTools.ExecutionMode = TARGET_VALUE; touched = true; }
      else if (em === TARGET_VALUE) return { path: filePath, action: "already", message: "already READ_WRITE" };
      else return { path: filePath, action: "skipped", message: `ExecutionMode=${em}` };
    } else {
      const servers = cfg?.servers;
      if (!servers || typeof servers !== "object") return { path: filePath, action: "skipped", message: "no servers block" };
      for (const name of Object.keys(servers)) {
        const srv = servers[name];
        const env = srv?.env;
        if (!env || env[ENV_KEY] === undefined) continue;
        if (env[ENV_KEY] === TARGET_VALUE) continue;
        if (env[ENV_KEY] !== SOURCE_VALUE) continue;
        env[ENV_KEY] = TARGET_VALUE;
        touched = true;
      }
      if (!touched) return { path: filePath, action: "already", message: "all servers already READ_WRITE or no READ_ONLY found" };
    }

    const bak = filePath + ".bak";
    if (!existsSync(bak)) { try { copyFileSync(filePath, bak); } catch {} }

    writeFileSync(filePath, JSON.stringify(cfg, null, 2));
    return { path: filePath, action: "patched" };
  } catch (e: any) {
    return { path: filePath, action: "error", message: e?.message || String(e) };
  }
}

const PRIVREG_HIVE = "HKLM\\GC2XY_SSMS_PRIVREG";
const VS_VERSION_RE = /^(\d+\.\d+)_/;
const REG_DWORD = "REG_DWORD";
const REG_SZ = "REG_SZ";

function findPrivateRegBins(): string[] {
  const candidates = new Set<string>();
  const la = process.env.LOCALAPPDATA;
  if (la) candidates.add(join(la, "Microsoft", "VisualStudio"));
  const userProfile = process.env.USERPROFILE || join(homedir());
  if (userProfile) candidates.add(join(userProfile, "AppData", "Local", "Microsoft", "VisualStudio"));
  for (const drv of enumerateFixedDrives()) {
    candidates.add(join(`${drv}:\\`, "Users", "Administrator", "AppData", "Local", "Microsoft", "VisualStudio"));
  }
  const results: string[] = [];
  for (const vsRoot of candidates) {
    if (!existsSync(vsRoot)) continue;
    let entries: string[] = [];
    try { entries = readdirSync(vsRoot); } catch { continue; }
    for (const entry of entries) {
      if (!VS_VERSION_RE.test(entry)) continue;
      const bin = join(vsRoot, entry, "privateregistry.bin");
      if (existsSync(bin) && results.indexOf(bin) === -1) results.push(bin);
    }
  }
  return results;
}

function regExec(cmd: string): string {
  try { return execSync(cmd, { encoding: "utf-8", timeout: 10000 }).trim(); } catch { return ""; }
}

function isHiveLoaded(): boolean {
  return regExec(`reg query "${PRIVREG_HIVE}"`).length > 0;
}

function ensureHiveUnloaded(): void {
  if (isHiveLoaded()) regExec(`reg unload "${PRIVREG_HIVE}"`);
}

function loadHive(binPath: string): string | null {
  ensureHiveUnloaded();
  const out = regExec(`reg load "${PRIVREG_HIVE}" "${binPath}"`);
  if (!isHiveLoaded()) return null;
  const query = regExec(`reg query "${PRIVREG_HIVE}\\Software\\Microsoft\\VisualStudio"`);
  for (const line of query.split("\n")) {
    const m = line.match(/VisualStudio\\(\S+)/);
    if (m) return m[1];
  }
  const binName = binPath.split(/[/\\]/).pop() || "";
  const m3 = binName.match(/^(\d+\.\d+_[^\\]+)/);
  return m3 ? m3[1] : null;
}

function regGet(vsKey: string, name: string): string | null {
  const out = regExec(`reg query "${vsKey}" /v "${name}"`);
  const m = out.match(/REG_[A-Z]+\s+(.+)/);
  return m ? m[1].trim() : null;
}

function regSet(vsKey: string, name: string, type: string, value: string): boolean {
  const out = regExec(`reg add "${vsKey}" /v "${name}" /t ${type} /d "${value}" /f`);
  return out.includes("operation completed successfully") || out.length > 0;
}

export interface RegPatchResult {
  privateregistry: string;
  vsSuffix: string;
  patches: { key: string; name: string; action: "set" | "already" | "error"; detail?: string }[];
  hiveUnloaded: boolean;
}

function patchPrivateRegistry(binPath: string, logFn: (msg: string) => void): RegPatchResult | null {
  const vsSuffix = loadHive(binPath);
  if (!vsSuffix) {
    logFn(`[MCP-WRITE] failed to load private registry: ${binPath}`);
    ensureHiveUnloaded();
    return null;
  }

  try {
    const usBase = `${PRIVREG_HIVE}\\Software\\Microsoft\\VisualStudio\\${vsSuffix}\\UnifiedSettings`;

    const patches: RegPatchResult["patches"] = [];

    const ffRoot = `${PRIVREG_HIVE}\\Software\\Microsoft\\VisualStudio\\${vsSuffix}\\FeatureFlags`;

    const settings: [string, string, string, string][] = [
      [usBase, "copilot.general.chat.enableMcpProvider+LastKnownUnifiedValue", REG_SZ, "True"],
      [usBase, "copilot.general.chat.enableMcpServerTrustDialog+LastKnownUnifiedValue", REG_SZ, "True"],
      [usBase, "copilot.general.chat.enableMcpProvider+LastMigrationFromLegacyAsFileTime", REG_SZ, String(Date.now() * 10000 + 116444736000000000)],
      [usBase, "copilot.general.chat.enableMcpServerTrustDialog+LastMigrationFromLegacyAsFileTime", REG_SZ, String(Date.now() * 10000 + 116444736000000000)],
      [ffRoot, "VS.Copilot.InternalUser", REG_DWORD, "1"],
      [`${ffRoot}\\SSMS\\Copilot`, "PreviewFeatureVisible", REG_DWORD, "1"],
      [`${ffRoot}\\SSMS\\Copilot`, "UseSSMSAgentModeResponder", REG_DWORD, "0"],
    ];

    for (const [key, name, type, value] of settings) {
      const cur = regGet(key, name);
      if (cur === value) {
        patches.push({ key, name, action: "already" });
      } else {
        const ok = regSet(key, name, type, value);
        patches.push({ key, name, action: ok ? "set" : "error", detail: `was=${cur}` });
      }
    }

    return { privateregistry: binPath, vsSuffix, patches, hiveUnloaded: true };
  } finally {
    ensureHiveUnloaded();
  }
}

export function patchPkgdefFiles(logFn: (msg: string) => void): McpPatchResult[] {
  const results: McpPatchResult[] = [];
  for (const drv of enumerateFixedDrives()) {
    for (const ssmsDir of findSsmsInstallDirs(drv)) {
      let entries: string[] = [];
      try { entries = readdirSync(ssmsDir); } catch { continue; }
      for (const entry of entries) {
        const sub = join(ssmsDir, entry);
        try { if (!statSync(sub).isDirectory()) continue; } catch { continue; }
        const pkgdef = join(sub, SSMS_MCP_REL, "..", "SSMSCopilotFeatureFlags.pkgdef");
        if (!existsSync(pkgdef)) continue;
        try {
          let raw = readFileSync(pkgdef, "utf-8");
          let touched = false;
          const replacements: [RegExp, string][] = [
            [/(\$RootKey\$\\FeatureFlags\\SSMS\\Copilot\\PreviewFeatureVisible]\s*\r?\n"Value"=dword:)00000000/g, "$100000001"],
            [/(\$RootKey\$\\FeatureFlags\\SSMS\\Copilot\\UseSSMSAgentModeResponder]\s*\r?\n"Value"=dword:)00000001/g, "$100000000"],
          ];
          for (const [re, rep] of replacements) {
            if (re.test(raw)) { raw = raw.replace(re, rep); touched = true; }
          }
          if (!touched) {
            results.push({ path: pkgdef, action: "already", message: "feature flags already patched or not found" });
            continue;
          }
          const bak = pkgdef + ".bak";
          if (!existsSync(bak)) { try { copyFileSync(pkgdef, bak); } catch {} }
          writeFileSync(pkgdef, raw);
          results.push({ path: pkgdef, action: "patched" });
          logFn(`[MCP-WRITE] patched pkgdef: PreviewFeatureVisible=1, UseSSMSAgentModeResponder=0`);
        } catch (e: any) {
          results.push({ path: pkgdef, action: "error", message: e?.message || String(e) });
        }
      }
    }
  }
  return results;
}

export function patchSsmsMcpConfigs(log?: (msg: string) => void): McpPatchResult[] {
  const logFn = log || ((msg: string) => console.log(msg));
  if (!isMcpWriteEnabled()) {
    logFn("[MCP-WRITE] disabled (MCP_WRITE=false in config.json or env)");
    return [];
  }
  const files = discoverSsmsMcpConfigs();
  if (files.length === 0) {
    logFn("[MCP-WRITE] no SSMS Copilot MCP configs found on disk");
    return [];
  }
  logFn(`[MCP-WRITE] discovered ${files.length} SSMS Copilot MCP config(s)`);
  const results: McpPatchResult[] = [];
  for (const f of files) {
    const r = patchSsmsMcpConfig(f);
    results.push(r);
    const short = f.length > 70 ? "..." + f.slice(f.length - 67) : f;
    if (r.action === "patched") logFn(`[MCP-WRITE] patched READ_ONLY -> READ_WRITE: ${short}`);
    else if (r.action === "already") logFn(`[MCP-WRITE] already READ_WRITE: ${short}`);
    else if (r.action === "error") logFn(`[MCP-WRITE] ERROR ${short}: ${r.message}`);
    else logFn(`[MCP-WRITE] skipped ${short}: ${r.message}`);
  }

  const pkgdefResults = patchPkgdefFiles(logFn);
  results.push(...pkgdefResults);

  const privRegBins = findPrivateRegBins();
  if (privRegBins.length > 0) {
    for (const bin of privRegBins) {
      const r = patchPrivateRegistry(bin, logFn);
      if (!r) continue;
      const setCount = r.patches.filter(p => p.action === "set").length;
      const alreadyCount = r.patches.filter(p => p.action === "already").length;
      logFn(`[MCP-WRITE] registry ${r.vsSuffix}: ${setCount} set, ${alreadyCount} already ok, hive unloaded=${r.hiveUnloaded}`);
    }
  } else {
    logFn("[MCP-WRITE] no VS private registry files found");
  }

  try {
    const cur = regExec(`reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v COPILOT_INTERNALUSER`);
    if (!cur.toLowerCase().includes("true")) {
      regExec(`reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v COPILOT_INTERNALUSER /t REG_SZ /d true /f`);
      logFn("[MCP-WRITE] set COPILOT_INTERNALUSER=true (system env)");
    } else {
      logFn("[MCP-WRITE] COPILOT_INTERNALUSER already set");
    }
  } catch {
    logFn("[MCP-WRITE] failed to set COPILOT_INTERNALUSER env var");
  }

  return results;
}
