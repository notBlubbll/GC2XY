// gc2xy Split Console — status banner + live log + keyboard commands
// Inspired by gc2xy logger.js dashboard

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const R = "\x1b[0;97;40m";
const B = "\x1b[1m";
const C = "\x1b[36m";
const S = "\x1b[90m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const M = "\x1b[35m";
const RED = "\x1b[91m";
const BLU = "\x1b[34m";
const O = "\x1b[38;5;214m";

// Colors that differ between dark/light bg
const W = "\x1b[97m";
const LG = "\x1b[38;5;248m";
const LIME = "\x1b[38;5;118m";

function forceDarkMode(): void {
  // Force dark background via OSC sequences (Windows Terminal + ConPTY)
  process.stdout.write("\x1b]11;rgb:0c/0c/0c\x1b\\");
  process.stdout.write("\x1b]10;rgb:cc/cc/cc\x1b\\");
  // Fallback for classic cmd.exe
  try { execSync("color 07", { timeout: 1000, stdio: "inherit" }); } catch {}
}

const LOGO = [
`${S}${B}█▀▀▀ █▀▀▀ ${C}${B}▀▀▀█ ${W}${B}█  █ █  █${R}`,
`${S}${B}█ ▀█ █    ${C}${B}█▀▀▀ ${W}${B}▄▀▀▄ ▀▀▀█${R}`,
`${S}${B}▀▀▀▀ ▀▀▀▀ ${C}${B}▀▀▀▀ ${W}${B}▀  ▀ ▀▀▀▀${R}`,
];

let _initialized = false;
let _buffer: { text: string; debug: boolean; ts: string }[] = [];
let _config: {
  mode: string; requests: number; port: number | string;
  target: string; cacheHits: number; PROXY: boolean; extra?: string;
  lastAgent?: string; tps?: number; runtime?: string; sku?: string;
} | null = null;

// ── TPS tracker (tokens per second, rolling 5-sample avg like OpencodeProxy) ──
let _tpsSamples: number[] = [];
let _lastTpsUpdate = 0;
let _cachedTps = 0;

export function recordTps(tokens: number, durationMs: number): void {
  if (!tokens || durationMs <= 10) return;
  const tps = (tokens / durationMs) * 1000;
  _tpsSamples.push(tps);
  if (_tpsSamples.length > 5) _tpsSamples.shift();
  const now = Date.now();
  if (now - _lastTpsUpdate > 2000) {
    _lastTpsUpdate = now;
    _cachedTps = _tpsSamples.reduce((a, b) => a + b, 0) / _tpsSamples.length;
  }
}

export function getTps(): number {
  // Recompute if stale (>2s since last sample)
  if (_tpsSamples.length === 0) return 0;
  const now = Date.now();
  if (now - _lastTpsUpdate > 4000) {
    // Decay toward zero when idle
    _cachedTps = _cachedTps * 0.5;
    _lastTpsUpdate = now;
  }
  return _cachedTps;
}
let _scrollOffset = 0;
let _debugOn = false;
let _recording = false;
let _showModels = true;
let _modelIds: string[] = [];
let _enabledModelIds: Set<string> = new Set();
let _cmdHandler: ((cmd: string) => void) | null = null;
let _origLog: typeof console.log | null = null;

export function ts(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

export function agentTag(headers: Record<string, string>): string {
  const ua = (headers["user-agent"] || "").toLowerCase();
  const ev = (headers["editor-version"] || "").toLowerCase();
  if (ev.startsWith("vs/visualstudio")) return `${O}VS${R}`;
  if (ua.startsWith("vscopilotclient")) return `${C}VSC${R}`;
  if (ua.startsWith("vsteamexplorer-github")) return `${BLU}TEAM${R}`;
  if (ua.startsWith("github-app")) return `${G}APP${R}`;
  if (ua.includes("undici")) return `${S}GDC${R}`;
  if (ua.includes("chrome") || ua.includes("chromium")) return `${Y}CHR${R}`;
  if (ua.includes("firefox")) return `${Y}FFX${R}`;
  if (ua.includes("edge")) return `${Y}EDG${R}`;
  if (ua.length > 0) return `${S}${ua.slice(0, 5).toUpperCase()}${R}`;
  return `${S}?${R}`;
}

export function agentName(headers: Record<string, string>): string {
  const ua = headers["user-agent"] || "";
  const ev = headers["editor-version"] || "";
  if (ev.startsWith("VS/VisualStudio")) {
    const parts = ev.split("/");
    if (parts.length >= 3) {
      const ver = parts[2].split(".").slice(0, 2).join(".");
      return `Visual Studio ${ver}`;
    }
    return "Visual Studio";
  }
  if (ua.startsWith("github-app/")) {
    const ver = ua.split("/")[1] || "";
    return `Github Copilot Desktop App${ver ? " v" + ver : ""}`;
  }
  if (ua.startsWith("VSCopilotClient/")) {
    return "VS Code Copilot Client";
  }
  if (ua.startsWith("VSTeamExplorer-GitHub/")) {
    return "VS Team Explorer GitHub";
  }
  if (ua.includes("undici")) {
    return "GitHub Copilot Desktop";
  }
  if (ua.includes("Chrome") || ua.includes("Chromium")) {
    return "Chrome";
  }
  if (ua.includes("Firefox")) {
    return "Firefox";
  }
  if (ua.includes("Edge")) {
    return "Edge";
  }
  if (ua.length > 0) {
    return ua.slice(0, 35);
  }
  return "Unknown";
}

export function colorMethod(method: string): string {
  switch (method.toUpperCase()) {
    case "GET": return `${G}GET${R}`;
    case "POST": return `${C}POST${R}`;
    case "PUT": return `${BLU}PUT${R}`;
    case "PATCH": return `${M}PATCH${R}`;
    case "DELETE": return `${RED}DEL${R}`;
    case "HEAD": return `${S}HEAD${R}`;
    default: return `${W}${method}${R}`;
  }
}

export function colorStatus(code: number): string {
  if (code >= 200 && code < 300) return `${G}${code}${R}`;
  if (code >= 300 && code < 400) return `${C}${code}${R}`;
  if (code >= 400 && code < 500) return `${Y}${code}${R}`;
  if (code >= 500) return `${RED}${code}${R}`;
  return `${S}${code}${R}`;
}

export function httpLogLine(
  direction: "REQ" | "RES",
  method: string,
  url: string,
  statusCode: number | null,
  agent: string,
  duration?: number,
): string {
  const arrow = direction === "REQ" ? `${S}>>>${R}` : `${G}<<<${R}`;
  const dur = duration != null ? ` ${S}[${duration}ms]${R}` : "";
  const status = statusCode != null ? ` ${colorStatus(statusCode)}` : "";
  return `${agent} ${arrow} ${colorMethod(method)} ${W}${url}${R}${status}${dur}`;
}

export function generalLogLine(level: string, msg: string): string {
  const levelTag = (() => {
    switch (level.toUpperCase()) {
      case "ERROR": return `${RED}ERROR${R}`;
      case "WARN": return `${Y}WARN ${R}`;
      case "INFO": return `${C}INFO ${R}`;
      case "READY": return `${LIME}READY${R}`;
      default: return `${S}${level.toUpperCase().padEnd(5)}${R}`;
    }
  })();
  return `${levelTag} ${msg}`;
}

// ── Request log (gc2xy-style: [tag][N]>[model] — "query preview" → [ms])
// Debug: full JSON preview. Non-debug: capped to fit terminal width.
// Returns arrow function (elapsed) => void if elapsed not provided immediately.
export function reqLog(opts: {
  tag?: string;
  provider?: string;
  model?: string;
  preview?: string;
  body?: any;
  elapsed?: number;
  sessionId?: number | string;
}): ((elapsed: number) => void) | void {
  const boxW = _currentWidth();
  const tagPart = opts.tag ? `${S}[${R}${opts.tag}${S}]${R}` : "";
  const sessionPart = opts.sessionId != null ? `[${C}${opts.sessionId}${R}]` : "";
  const provModel = `[${opts.provider || "?"}/${B}${opts.model || "?"}${R}]`;
  const prefix = `${tagPart}${sessionPart}>${provModel}`;

  let trail = "";
  const showBody = _debugOn && opts.body != null;
  if (opts.preview || showBody) {
    if (_debugOn) {
      trail = ` ${S}—${R} ${W}${JSON.stringify(showBody ? opts.body : opts.preview)}${R}`;
    } else {
      const sep = ` ${S}—${R} `;
      const prefixLen = visLen(prefix);
      const maxSuffixLen = 14;
      const maxTrailLen = Math.max(1, boxW - 4 - prefixLen - maxSuffixLen);
      const rawTrail = sep + `"${opts.preview}"`;
      if (visLen(rawTrail) <= maxTrailLen) {
        trail = rawTrail;
      } else {
        let maxChunk = Math.max(1, maxTrailLen - visLen(sep) - 3);
        let chunk = opts.preview.slice(0, maxChunk);
        while (chunk.length > 0 && visLen(sep + `"${chunk}\u2026"`) > maxTrailLen) {
          chunk = chunk.slice(0, -1);
        }
        trail = chunk ? sep + `"${chunk}\u2026"` : "";
      }
    }
  }

  if (opts.elapsed != null) {
    const msg = `${prefix}${trail} ${G}→${R} [${opts.elapsed}ms]`;
    _pushLog(msg, false);
    return;
  }

  // No elapsed yet — push pending line, return arrow function that replaces it in-place
  if (!_initialized) return () => {};
  const pendingMsg = `${prefix}${trail} ${S}—${R} ${S}…${R}`;
  const bufIdx = _buffer.length;
  _buffer.push({ text: pendingMsg, debug: false, ts: ts() });
  _scrollOffset = 0;
  _redraw();
  return (elapsed: number) => {
    const completedMsg = `${prefix}${trail} ${G}→${R} [${elapsed}ms]`;
    if (bufIdx < _buffer.length) {
      _buffer[bufIdx] = { text: completedMsg, debug: false, ts: ts() };
    }
    _scrollOffset = 0;
    _redraw();
  };
}

function _pushLog(msg: string, isDebug: boolean): void {
  if (!_initialized) return;
  const clean = msg.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return;
  _buffer.push({ text: clean, debug: isDebug, ts: ts() });
  _scrollOffset = 0;
  _redraw();
}

// ── Visible buffer (filters debug entries when debug is off) ──
function _visibleBuffer(): { text: string; debug: boolean; ts: string }[] {
  return _debugOn ? _buffer : _buffer.filter(e => !e.debug);
}

// ── Visible-length helpers ──
function visLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

// Truncate a string with ANSI codes to maxVis visible characters (no line wrapping)
function visTruncate(s: string, maxVis: number): string {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  if (plain.length <= maxVis) return s;
  const target = plain.slice(0, maxVis);
  let result = "";
  let pos = 0;
  const segments = s.split(/(\x1b\[[0-9;]*m)/);
  for (const seg of segments) {
    if (/^\x1b\[[0-9;]*m$/.test(seg)) {
      result += seg;
    } else {
      const remain = target.slice(pos);
      const take = Math.min(seg.length, remain.length);
      if (take <= 0) break;
      result += seg.slice(0, take);
      pos += take;
    }
  }
  return result;
}

function _wrapList(items: string[], maxWidth: number, separator = " "): string[] {
  const rows: string[] = [];
  let cur = "";
  for (const item of items) {
    const sep = cur ? separator : "";
    if (visLen(cur + sep + item) > maxWidth) {
      rows.push(cur);
      cur = item;
    } else {
      cur += sep + item;
    }
  }
  if (cur) rows.push(cur);
  return rows.length ? rows : [items.join(separator)];
}

// ── Status area builders ──
function box(content: string, width: number): string {
  const vis = visLen(content);
  const pad = Math.max(1, width - vis - 3);
  return `${S}│${R} ${content}${" ".repeat(pad)}${S}│${R}`;
}

function line(content: string, width: number): string {
  const vis = visLen(content);
  const pad = Math.max(1, width - vis - 3);
  return `${S}│${R} ${content}${" ".repeat(pad)}${S}│${R}`;
}

function buildStatusLines(width: number): string[] {
  const lines: string[] = [];
  const modeTag = _config?.mode ?? "MOCK";

  // Logo + Models on right (compute logoPad early for separator position)
  const rightWidth = Math.max(10, width - 48);
  const logoPad = Math.max(...LOGO.map(l => visLen(l)));
  const sepPos = logoPad + 3;

  // Top border
  const topHorz = Math.max(0, width - 10);
  if (sepPos >= 9 && sepPos <= width - 2) {
    const topBefore = sepPos - 9;
    const topAfter = topHorz - topBefore - 1;
    lines.push(`${W}┌${R}${S}${BOX_H} gc2xy ${BOX_H.repeat(topBefore)}${R}${W}┬${R}${S}${BOX_H.repeat(topAfter)}${R}${W}┐${R}`);
  } else {
    lines.push(`${W}┌${R}${S}${BOX_H} gc2xy ${BOX_H.repeat(topHorz)}${R}${W}┐${R}`);
  }
  const blankLeft = " ".repeat(logoPad);
  let modelRows: string[] = [];
  if (_modelIds.length > 0) {
    const colorModel = (s: string) => _enabledModelIds.has(s) ? `${LIME}${s}${R}` : `${LG}${s}${R}`;
    const isOther = (m: string) => m.startsWith("codestral/") || m.startsWith("bitnet/") || m === "bitnet-demo";
    const poll = _modelIds.filter(m => m.startsWith("pol/")).map(colorModel);
    const freebuff = _modelIds.filter(m => m.startsWith("freebuff/")).map(colorModel);
    const featherless = _modelIds.filter(m => m.startsWith("featherless/") && _enabledModelIds.has(m)).map(colorModel);
    const other = _modelIds.filter(m => isOther(m)).map(colorModel);
    const premium = _modelIds.filter(m => !m.startsWith("pol/") && !m.startsWith("freebuff/") && !m.startsWith("featherless/") && !isOther(m)).map(colorModel);
    const pollRows = _wrapList(poll, rightWidth, ", ");
    const fbRows = _wrapList(freebuff, rightWidth, ", ");
    const flRows = _wrapList(featherless, rightWidth, ", ");
    const otherRows = _wrapList(other, rightWidth, ", ");
    const premRows = _wrapList(premium, rightWidth, ", ");
    modelRows = pollRows.map((r, i) => i === 0 ? `${Y}POLL:${R}${LG} ${r}${R}` : `${LG}${r}${R}`);
    if (fbRows.length > 0) {
      modelRows = modelRows.concat(fbRows.map((r, i) => i === 0 ? `${Y}FREEBUFF:${R}${LG} ${r}${R}` : `${LG}${r}${R}`));
    }
    if (flRows.length > 0) {
      modelRows = modelRows.concat(flRows.map((r, i) => i === 0 ? `${M}FEATHERLESS:${R}${LG} ${r}${R}` : `${LG}${r}${R}`));
    }
    if (premRows.length > 0) {
      modelRows = modelRows.concat(premRows.map((r, i) => i === 0 ? `${M}OC-GO:${R}${LG} ${r}${R}` : `${LG}${r}${R}`));
    }
    if (otherRows.length > 0) {
      modelRows = modelRows.concat(otherRows.map((r, i) => i === 0 ? `${M}OTHER:${R}${LG} ${r}${R}` : `${LG}${r}${R}`));
    }
  } else {
    modelRows = ["", `${LG}loading models...${R}`, ""];
  }
  const extraRows = modelRows.slice(LOGO.length).filter(r => r.length > 0);
  const allRows = [
    { left: null, row: modelRows[0] || "" },
    ...LOGO.map((l, i) => ({ left: l, row: modelRows[i + 1] || "" })),
    ...extraRows.slice(1).map(r => ({ left: null, row: r })),
  ];
  for (const r of allRows) {
    const leftText = r.left != null ? r.left : "";
    const leftVis = r.left != null ? visLen(leftText) : 0;
    const leftPad = r.left != null ? " ".repeat(logoPad - leftVis) : blankLeft;
    lines.push(box(`${leftText}${leftPad} ${S}│${R} ${r.row}`, width));
  }

  // Separator
  if (sepPos >= 1 && sepPos <= width - 2) {
    const sepBefore = sepPos - 1;
    const sepAfter = (width - 2) - sepPos;
    lines.push(`${W}├${R}${S}${BOX_H.repeat(sepBefore)}${R}${W}┴${R}${S}${BOX_H.repeat(sepAfter)}${R}${W}┤${R}`);
  } else {
    lines.push(`${W}├${R}${S}${BOX_H.repeat(width - 2)}${R}${W}┤${R}`);
  }

  // TPS display — always read live from rolling window, never from stale config
  const tps = getTps();
  const tpsStr = tps >= 0.1 ? `${W}${tps.toFixed(1)} ${S}t/s${R}` : `${S}0.0 t/s${R}`;

  // Status line: evenly spaced
  const statusParts = [
    `${C}v3${R} ${S}│${R} ${W}${_config?.runtime?.split("/")[0] || "?"}${R}${S}/${R}${O}${_config?.runtime?.split("/")[1] || "?"}${R} ${S}│${R} ${S}M:${R} ${W}${modeTag}${R}`,
    `${S}SKU:${R} ${W}${_config?.sku || "ent"}${R}`,
    `${S}Req:${R} ${W}${_config?.requests ?? 0}${R}`,
    `${S}Port:${R} ${W}${_config?.port ?? "-"}${R}`,
    `${O}Agent:${R} ${W}${_config?.lastAgent || "Unknown"}${R}`,
    `${G}●${R} ${tpsStr}`,
  ];
  const availW = width - 4;
  const partsVis = statusParts.map(p => visLen(p));
  const totalText = partsVis.reduce((a, b) => a + b, 0);
  const sepCount = statusParts.length - 1;
  const gap = Math.max(0, Math.floor((availW - totalText - sepCount * 3) / sepCount));
  let statusLine = statusParts[0];
  for (let i = 1; i < statusParts.length; i++) {
    statusLine += `${" ".repeat(gap)} ${S}│${R} ${statusParts[i]}`;
  }
  lines.push(box(statusLine, width));
  lines.push(`${W}├${R}${S}${BOX_H.repeat(width - 2)}${R}${W}┤${R}`);

  // Commands line (gc2xy-style)
  const dc = _debugOn ? G : S;
  const recDot = _recording ? `${RED}\u25CF${R}` : `${S}\u25CB${R}`;
  const m1 = modeTag === "MOCK" ? `${G}1${R}=mock` : `${S}1${R}=mock`;
  const m2 = modeTag === "HYBRID" ? `${G}2${R}=hybrid` : `${S}2${R}=hybrid`;
  const m3 = modeTag === "PROXY" ? `${G}3${R}=proxy` : `${S}3${R}=proxy`;
  const tail = `${recDot} ${M}e${R}=rec ${M}r${R}=rst ${dc}d${R}=dbg ${M}m${R}=mdls ${S}\u2191\u2193 PgUp PgDn wheel${R}`;
  const modeKeys = `${m1} ${m2} ${m3}  ${tail}`;
  lines.push(line(`${S}Commands:${R} ${modeKeys}`, width));

  // Bottom border
  lines.push(`${W}└${R}${S}${BOX_H.repeat(width - 2)}${R}${W}┘${R}`);

  return lines;
}

const BOX_H = "─";

export function isDebug(): boolean {
  return _debugOn;
}

export function debugLog(...args: any[]): void {
  // Single string arg: push to dashboard buffer as debug entry
  if (args.length === 1 && typeof args[0] === "string") {
    _pushLog(args[0], true);
  }
}

export function setDebug(on: boolean): void {
  _debugOn = on;
  if (_initialized) _redraw();
}

export function toggleDebug(): boolean {
  _debugOn = !_debugOn;
  if (_initialized) _redraw();
  return _debugOn;
}

export function setRecording(on: boolean): void {
  _recording = on;
  if (_initialized) _redraw();
}

export function setModelsList(ids: string[]): void {
  _modelIds = ids;
  if (_initialized) _redraw();
}

export function setEnabledModelIds(ids: Set<string>): void {
  if (_setsEqual(_enabledModelIds, ids)) return;
  _enabledModelIds = ids;
  if (_initialized) _redraw();
}

function _setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

export function onCommand(fn: (cmd: string) => void): void {
  _cmdHandler = fn;
}

function _emitCmd(cmd: string): void {
  if (_cmdHandler) _cmdHandler(cmd);
}

// ── Keyboard handler ──
function _onKey(buf: Buffer): void {
  const s = buf.toString();
  const vis = _visibleBuffer();
  const width = _currentWidth();
  const rows = process.stdout.rows || 25;
  const headerRows = buildStatusLines(width).length;
  // In scroll mode (offset > 0), one extra line used for page indicator
  const availLogLines = Math.max(1, rows - headerRows - 1);

  // Up arrow
  if (s === "\x1b[A" || s === "\x1bOA") {
    const maxOff = vis.length > availLogLines ? vis.length - availLogLines + 1 : 0;
    if (_scrollOffset < maxOff) _scrollOffset++;
    _redraw();
    return;
  }
  // Down arrow
  if (s === "\x1b[B" || s === "\x1bOB") {
    _scrollOffset = Math.max(0, _scrollOffset - 1);
    _redraw();
    return;
  }
  // Page Up
  if (s === "\x1b[5~") {
    _scrollOffset = Math.min(vis.length - availLogLines, _scrollOffset + availLogLines);
    _redraw();
    return;
  }
  // Page Down
  if (s === "\x1b[6~") {
    _scrollOffset = Math.max(0, _scrollOffset - availLogLines);
    _redraw();
    return;
  }
  // Home (go to oldest entry)
  if (s === "\x1b[H" || s === "\x1bOH") {
    _scrollOffset = Math.max(0, vis.length - availLogLines + (vis.length > availLogLines ? 1 : 0));
    _redraw();
    return;
  }
  // End (go to live tail)
  if (s === "\x1b[F" || s === "\x1bOF") {
    _scrollOffset = 0;
    _redraw();
    return;
  }
  // Mouse scroll wheel (X10 protocol: ESC[M<btn+32><col+32><row+32>)
  if (buf.length >= 6 && buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x4d) {
    const btn = buf[3] - 32;
    const maxOff = vis.length > availLogLines ? vis.length - availLogLines + 1 : 0;
    if (btn === 64) {
      _scrollOffset = Math.min(maxOff, _scrollOffset + 3);
      _redraw();
      return;
    }
    if (btn === 65) {
      _scrollOffset = Math.max(0, _scrollOffset - 3);
      _redraw();
      return;
    }
  }

  // Ctrl+C
  if (s === "\x03") {
    process.stdout.write("^C\n");
    _emitCmd("stop");
    return;
  }
  // Single key commands: D = debug toggle (no Enter needed)
  if (s.toLowerCase() === "d") {
    const nowOn = toggleDebug();
    // gc2xy style: log the change after toggle
    _pushLog(`${nowOn ? G : S}DEBUG ${nowOn ? "ON" : "OFF"}${R}`, false);
    return;
  }
  // R = restart (immediate)
  if (s.toLowerCase() === "r") {
    _pushLog(`${M}RESTART${R} triggered`, false);
    _emitCmd("restart");
    return;
  }
  // E = recording toggle (dot button)
  if (s.toLowerCase() === "e") {
    _recording = !_recording;
    const dot = _recording ? `${RED}●${R}` : `${S}○${R}`;
    _pushLog(`${dot} ${S}[${R}${RED}RECORD${R}${S}]${R} ${_recording ? "ON" : "OFF"}${R}`, false);
    _emitCmd(_recording ? "record" : "stoprecord");
    _redraw();
    return;
  }
  // 1 = switch to MOCK mode
  if (s === "1") {
    _pushLog(`${M}SWITCH${R} → MOCK mode`, false);
    _emitCmd("switch:mock");
    return;
  }
  // 2 = switch to HYBRID (PROXY) mode
  if (s === "2") {
    _pushLog(`${M}SWITCH${R} → HYBRID (proxy) mode`, false);
    _emitCmd("switch:hybrid");
    return;
  }
  // 3 = switch to PROXY mode
  if (s === "3") {
    _pushLog(`${M}SWITCH${R} → PROXY mode`, false);
    _emitCmd("switch:proxy");
    return;
  }
  // M = model refresh
  if (s.toLowerCase() === "m") {
    _pushLog(`${M}MODEL REFRESH${R} triggered`, false);
    _emitCmd("refresh");
    return;
  }
}

function _availLogLines(): number {
  const rows = process.stdout.rows || 25;
  const width = process.stdout.columns || 80;
  const headerRows = buildStatusLines(width).length;
  return Math.max(1, rows - headerRows - 1);
}

function _currentWidth(): number {
  return process.stdout.columns || 80;
}

// ── Redraw ──
function _redraw(): void {
  if (!_initialized) return;

  const width = process.stdout.columns || 80;
  const rows = process.stdout.rows || 25;
  const statusLines = buildStatusLines(width);
  const headerRows = statusLines.length;
  const vis = _visibleBuffer();
  const total = vis.length;

  // Clamp scroll offset
  const availLogLines = Math.max(1, rows - headerRows - 1);

  // Page indicator takes a line when scrolling, reducing log lines by 1
  const logLines = _scrollOffset > 0 && total >= availLogLines
    ? Math.max(1, availLogLines - 1)
    : availLogLines;
  const maxOff = Math.max(0, total - logLines);
  if (_scrollOffset > maxOff) _scrollOffset = maxOff;

  const isScrolling = _scrollOffset > 0;

  let out = "\x1b[40m\x1b[H\x1b[J";
  // Cheap OSC 9 fallback (harmless, might work in ConPTY mode)
  try { process.stdout.write(`\x1b]9;4;3;00FFFF\x1b\\`); } catch {}
  // Reset terminal default colors to dark (in case color scheme overrides)
  try { process.stdout.write("\x1b]11;rgb:0c/0c/0c\x1b\\"); } catch {}
  try { process.stdout.write("\x1b]10;rgb:ff/ff/ff\x1b\\"); } catch {}

  // Status area
  for (const line of statusLines) out += line + "\n";

  const start = Math.max(0, total - logLines - _scrollOffset);
  const end = Math.min(total, start + logLines);
  let entriesRendered = 0;

  // Page indicator
  if (isScrolling) {
    const pages = Math.max(1, Math.ceil(total / logLines));
    const page = Math.max(1, Math.ceil((total - _scrollOffset) / logLines));
    out += `${S}─ page ${page}/${pages} ─ ${total} entries ─ PgDn / ↓ / any key = live tail ─${R}\n`;
    entriesRendered++;
  }

  // Log entries (truncated to prevent terminal wrapping)
  const maxLineWidth = width;
  for (let i = start; i < end; i++) {
    const line = `${S}${vis[i].ts}${R} ${vis[i].text}`;
    out += visTruncate(line, maxLineWidth) + "\n";
    entriesRendered++;
  }

  // Pad remaining lines
  for (let i = entriesRendered; i < availLogLines; i++) {
    if (!isScrolling && total === 0 && i === 0) {
      out += `${S}  idle...${R}\n`;
    } else if (!isScrolling && i === availLogLines - 1) {
      out += `${S}─ live tail (${total}) ─ 1${R}=mock ${S}2${R}=hybrid ${S}3${R}=proxy ${M}r${R}=rst ${dc()}=dbg ↑↓ PgUp/PgDn${R}\n`;
    } else {
      out += "\n";
    }
  }

  // Reset scroll mode on any key while in scroll mode (but not scroll keys themselves)
  // Handled in _onKey

  process.stdout.write(out);
}

function dc(): string {
  return _debugOn ? `${G}d${R}` : `${S}d${R}`;
}

// ── Windows Terminal tab color via settings.json ──
// Windows Terminal hot-reloads settings.json instantly. We add/remove
// profiles.defaults.tabColor to set the tab color at runtime.
// This is the only reliable way to set the tab color from a native Windows process,
// since OSC 9 (tab color escape) is blocked by ConHost.

let _prevTabColors = new Map<string, string | undefined>();

function _wtSettingsPaths(): string[] {
  const local = process.env.LOCALAPPDATA || "";
  if (!local) return [];
  const base = (pkg: string) => `${local}\\Packages\\${pkg}\\LocalState\\settings.json`;
  return [
    base("Microsoft.WindowsTerminal_8wekyb3d8bbwe"),
    base("Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe"),
  ];
}

function _applyTabColor(hex: string | null): void {
  for (const p of _wtSettingsPaths()) {
    try {
      if (!existsSync(p)) continue;
      const raw = readFileSync(p, "utf-8");
      const json = JSON.parse(raw);
      if (hex) {
        // Save previous value only once
        if (!_prevTabColors.has(p)) {
          _prevTabColors.set(p, json.profiles?.defaults?.tabColor);
        }
        json.profiles = json.profiles || {};
        json.profiles.defaults = json.profiles.defaults || {};
        json.profiles.defaults.tabColor = `#${hex}`;
      } else {
        const prev = _prevTabColors.get(p);
        if (prev) {
          json.profiles.defaults = json.profiles.defaults || {};
          json.profiles.defaults.tabColor = prev;
        } else {
          if (json.profiles?.defaults?.tabColor) delete json.profiles.defaults.tabColor;
        }
      }
      writeFileSync(p, JSON.stringify(json, null, 2), "utf-8");
    } catch {}
  }
}

function setTabColor(hex: string): void {
  _applyTabColor(hex);
  // Fallback: try OSC 9 escape (works in some configs e.g. WSL via ConPTY)
  const seq = `\x1b]9;4;3;${hex}\x1b\\`;
  try { process.stdout.write(seq); } catch {}
  try { require("fs").writeSync(1, seq); } catch {}
}

function resetTabColor(): void {
  _applyTabColor(null);
  const seq = "\x1b]9;4;3;\x1b\\";
  try { process.stdout.write(seq); } catch {}
  try { require("fs").writeSync(1, seq); } catch {}
}

// ── Public API ──

export function initSplitConsole(): void {
  if (_initialized) return;
  _initialized = true;

  // Detect console background and apply proper color scheme
  forceDarkMode();

  setDefaultConfig();

  // Enter alternate screen buffer
  process.stdout.write("\x1b[?1049h");

  setTabColor("00FFFF");

  // Patch console.log globally
  // Most `[`-prefixed messages are handler logs; only specific noisy ones are debug-only.
  // Important: [VS SESSION], [COPILOT SESSION], [VISUAL STUDIO], [MODEL] show without debug.
  const _debugPrefixes = [
    "[RESP BODY]", "[REASONING CACHE]", "[FAKE GHE]", "[FAKE DEVICE LOGIN]", "[FAKE DEVICE]",
    "[RECORD]", "[REPLAY]", "[MOCK V1/MESSAGES]", "[MOCK FALLBACK]", "[VISUAL STUDIO]",
    "[VS SESSION]", "[COPILOT SESSION]",
  ];
  _origLog = console.log;
  console.log = (...args: any[]) => {
    if (!_initialized) { _origLog!(...args); return; }
    const msg = args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ").replace(/\n/g, " ").replace(/\s+/g, " ").trim();
    if (!msg) return;
    const isDebug = _debugPrefixes.some(p => msg.startsWith(p));
    _buffer.push({ text: msg, debug: isDebug, ts: ts() });
    _scrollOffset = 0;
    _redraw();
  };

  // Set up raw-mode keyboard input
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", _onKey);
    } catch {}
  }

  // Listen for terminal resize
  process.stdout.on("resize", () => { if (_initialized) _redraw(); });

  _redraw();
}

function setDefaultConfig(): void {
  _config = { mode: "MOCK", requests: 0, port: "-", target: "github.com", cacheHits: 0, PROXY: false, lastAgent: undefined, tps: 0, sku: "ent" };
}

export function drawStatusBar(config: {
  mode: string;
  requests: number;
  port: number | string;
  target: string;
  cacheHits: number;
  PROXY: boolean;
  extra?: string;
  lastAgent?: string;
  tps?: number;
  runtime?: string;
  sku?: string;
}): void {
  _config = config;
  if (_initialized) _redraw();
}

export function restoreTerminal(): void {
  if (_initialized) {
    try { process.stdin.setRawMode(false); } catch {}
    if (_origLog) console.log = _origLog;
    process.stdout.write("\x1b[?1049l");
    resetTabColor();
    _initialized = false;
  }
}
