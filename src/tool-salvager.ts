// ── Tool Salvager ──
//
// Per-tool schema coercion + JSON salvage + apology detection + loop breaking
// for upstream LLM tool calls destined for VS / VS Code / Copilot / SQL Studio.
//
// Problem we solve: small/upstream LLMs (Agnes, Pollinations, Freebuff, etc.)
// frequently emit tool calls that are:
//
//   1. Schema-drift      — `filePath` instead of `filename` for `get_file`
//   2. Type-drift        — `"endLine": "100"` (string) instead of `100` (number)
//   3. Broken JSON       — truncated content, unescaped backslashes in Windows paths
//   4. Apology text      — "I apologize, I'm unable to retrieve the contents..."
//                          (model gives up on a tool instead of completing the task)
//   5. Infinite loop     — calls `get_file` over and over with different params
//                          (model stuck, will never return a final answer)
//
// The salvager runs in two stages:
//   A. `normalizeToolCall(tc)`     — happy path: coerce types/aliases/aliases
//   B. `salvageToolCall(tc)`       — fallback: regex-extract from broken JSON
//
// Plus two higher-level helpers used by the response builders:
//   `detectApologyText(text)`      — "I apologize, I can't..." refusal detector
//   `detectToolLoop(messages,tc)`  — same tool called N times with same args
//
// When ANY of the above fire, the caller substitutes a synthetic
// `task_complete` tool_use so VS stops waiting and shows the user a result.
//
// Inspired by gc2oc's `normalizeToolCall` (see
// https://github.com/notBlubbll/gc2oc/blob/main/src/server.js — search for
// `normalizeToolCall` / `_tool400Streak` / `_stripOrphanedToolCalls`).

import forge from "node-forge";

// ── Tool name recovery from ID ─────────────────────────────────────────────
//
// Small/upstream LLMs (Kimi K2.7, Qwen 3.6, Agnes-2.0-Flash, etc.) frequently
// emit tool calls where the function name is embedded in the tool_call ID
// rather than in `function.name`. Observed patterns from proxy captures:
//
//   id="functions.get_projects_in_solution:0"  name=""
//   id="functions.ask_question:0"             name=""
//   id="functions.file_search:1"              name=""
//   id="functions.run_command_in_terminal:2"  name=""
//
// VS requires a non-empty `name` on every `tool_use` block — a blank name
// means VS cannot dispatch the tool, returns a null tool_result, and the
// polluted (nameless) assistant turn leaks into the next request's context
// (see `.proxy-logs/vs-messages.log` lines 154/158/178/198/202/214/218/222
// where `function.name` is `""` and the follow-up tool_result is null).
//
// This helper extracts the tool name from such IDs so the salvager and the
// streaming emitters can recover it before forwarding to VS.
const TOOL_NAME_FROM_ID_RE = /^functions?\.(.+?):\d+$/;
export function extractNameFromToolId(id: string | undefined | null): string {
  if (!id || typeof id !== "string") return "";
  const m = TOOL_NAME_FROM_ID_RE.exec(id.trim());
  return m ? m[1] : "";
}

// ── Path escape fix ────────────────────────────────────────────────────────
// AI writes Windows paths like `dir\ntl\file` inside JSON strings. JSON.parse
// interprets `\n` as a newline, `\t` as a tab, `\r` as CR — destroying the
// path. We detect & re-escape on the raw string BEFORE parsing.
function _fixPathEscapes(s: string): string {
  if (typeof s !== "string") return s;
  return s.replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\r/g, "\\r");
}

// Helper: extract the first capture group from a string by a regex, or null.
// We use new RegExp() to avoid parser confusion with unbalanced parens in
// regex literals (the unterminated-string fallback patterns).
function _extract(reSrc: string, src: string): string | null {
  const m = new RegExp(reSrc).exec(src);
  return m ? m[1] : null;
}

function _test(reSrc: string, src: string): boolean {
  return new RegExp(reSrc).test(src);
}

// ── Stage A: happy-path normalization ──────────────────────────────────────
//
// Coerces LLM tool calls to match the exact VS schema for each tool. Handles
// camelCase ↔ snake_case, alternative field names, and type coercion. Returns
// the repaired tool call, or `null` if the tool name is unrecognized.
//
// If JSON.parse throws, the caller should fall through to `salvageToolCall`.
export function normalizeToolCall(tc: any): any | null {
  // Recover the tool name when the LLM embedded it in the tool_call ID
  // instead of `function.name` (Kimi K2.7, Qwen 3.6, Agnes — see
  // `.proxy-logs/streaming-responses.log` for `functions.<name>:N` IDs
  // paired with empty names). We patch the clone's name in-place so the
  // rest of the salvager (and the SSE emitter) sees a real name.
  let name = (tc?.function?.name || "").trim();
  if (!name) {
    const recovered = extractNameFromToolId(tc?.id || tc?.function?.id);
    if (recovered) {
      name = recovered;
      // Mutate a shallow clone so callers that reuse `tc` upstream still
      // see the original (broken) shape; downstream consumers get the fix.
      tc = {
        ...tc,
        id: tc?.id,
        type: tc?.type || "function",
        function: { ...(tc?.function || {}), name },
      };
    }
  }
  if (!name) return null;

  const raw = tc.function.arguments || "{}";

  let json = String(raw);
  // Fix invalid escape sequences: \_ → \\_ (AI writes \_ but JSON only allows
  // \\, \n, \t, \", etc.). Negative lookbehind avoids matching \\_ (already
  // valid: escaped backslash + _).
  json = json.replace(new RegExp("(?<!\\\\)\\\\([^\"\\\\\\/bfnrtu])", "g"), "\\\\$1");
  // "queries": foo → "queries":["foo"]
  json = json.replace(/"queries"\s*:\s*([^\[",}\s][^,}]*)/, (_, v: string) => {
    const t = v.trim();
    if (/^(?:null|true|false|-?\d)/.test(t)) return `"queries":${t}`;
    return `"queries":["${t}"]`;
  });
  // "includePattern": *.cs → "includePattern":"*.cs"
  json = json.replace(/"includePattern"\s*:\s*([^",}\s]+)(?=\s*[,}]|$)/, (_, v: string) => {
    if (/^(?:null|true|false|-?\d)/.test(v)) return `"includePattern":${v}`;
    return `"includePattern":"${v}"`;
  });
  // "query": frontpage → "query":"frontpage" (any bare-identifier string field)
  json = json.replace(/"query"\s*:\s*([^",}\s]+)(?=\s*[,}]|$)/g, (_, v: string) => {
    if (/^(?:null|true|false|-?\d)/.test(v)) return `"query":${v}`;
    return `"query":"${v}"`;
  });
  // Multi-word unquoted string values: "summary": List files → "summary":"List files"
  // Only matches when the value is NOT already a quoted string, object, array,
  // number, or boolean. The negative lookahead `(?!\s*["{\[\d-])` at the value
  // start ensures we skip already-valid JSON values. The value body
  // `[^,}]+?` is non-greedy up to the next comma/brace.
  json = json.replace(
    /"(summary|description|details|agentName|memory|reason|prompt)"\s*:\s*(?!\s*["'{\[\d-])([^,}]+?)(?=\s*,\s*"|\s*}$|$)/g,
    (_, field: string, val: string) => {
      const t = val.trim().replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      if (!t) return `"${field}":""`;
      return `"${field}":"${t}"`;
    }
  );

  let args: any;
  try {
    args = JSON.parse(json);
  } catch {
    return null; // caller falls through to salvage
  }
  if (args == null || typeof args !== "object") args = {};
  const safe: any = {};

  if (/^get_file$/i.test(name)) {
    // VS: required ["filename","startLine","endLine"]
    safe.filename = _fixPathEscapes(
      String(args.filename ?? args.filePath ?? args.path ?? args.uri ?? args.resource ?? "")
    );
    safe.startLine =
      typeof args.startLine === "number" && args.startLine >= 1 ? args.startLine : 1;
    safe.endLine =
      typeof args.endLine === "number" && args.endLine >= safe.startLine
        ? args.endLine
        : 999999;
    // Expand small ranges to full file — prevents line-by-line reads
    if (safe.endLine < 200 && safe.endLine !== 999999) safe.endLine = 999999;
    if (typeof args.includeLineNumbers === "boolean") safe.includeLineNumbers = args.includeLineNumbers;
  } else if (/^read_file$/i.test(name)) {
    // VSCode: required ["filePath","startLine","endLine"]
    safe.filePath = _fixPathEscapes(
      String(args.filePath ?? args.filename ?? args.path ?? args.uri ?? "")
    );
    safe.startLine =
      typeof args.startLine === "number" && args.startLine >= 1 ? args.startLine : 1;
    safe.endLine =
      typeof args.endLine === "number" && args.endLine >= safe.startLine
        ? args.endLine
        : 999999;
    if (safe.endLine < 200 && safe.endLine !== 999999) safe.endLine = 999999;
  } else if (/^(grep_search|search_content|search_file)$/i.test(name)) {
    safe.query = String(args.query ?? args.pattern ?? args.search ?? args.searchTerm ?? "");
    safe.isRegexp =
      typeof args.isRegexp === "boolean"
        ? args.isRegexp
        : typeof args.regex === "boolean"
        ? args.regex
        : false;
    safe.includePattern = args.includePattern ?? args.include ?? args.fileTypes ?? args.glob ?? null;
    if (safe.includePattern !== null) safe.includePattern = _fixPathEscapes(String(safe.includePattern));
    safe.maxResults =
      typeof args.maxResults === "number" && args.maxResults >= 1 ? args.maxResults : 20;
  } else if (/^replace_string_in_file$/i.test(name)) {
    safe.filePath = _fixPathEscapes(
      String(args.filePath ?? args.path ?? args.filename ?? args.file ?? "")
    );
    safe.oldString = String(
      args.oldString ?? args.old_string ?? args.old_str ?? args.search ?? args.old_text ?? ""
    );
    safe.newString = String(
      args.newString ?? args.new_string ?? args.new_str ?? args.replace ?? args.new_text ?? ""
    );
  } else if (/^multi_replace_string_in_file$/i.test(name)) {
    const list =
      args.replacements ?? args.edits ?? args.changes ?? args.patches ?? args.operations ?? args.diffs;
    if (Array.isArray(list)) {
      safe.replacements = list.map((r: any) => {
        const e: any = {};
        e.filePath = _fixPathEscapes(
          String(r.filePath ?? r.filepath ?? r.path ?? r.filename ?? r.file ?? "")
        );
        e.oldString = String(
          r.oldString ?? r.old_str ?? r.search ?? r.old_text ?? r.find ?? r.from ?? ""
        );
        e.newString = String(
          r.newString ?? r.new_str ?? r.replace ?? r.new_text ?? r.to ?? ""
        );
        return e;
      });
    } else {
      const so = String(args.oldString ?? args.old_str ?? args.search ?? args.old_text ?? "");
      const sn = String(args.newString ?? args.new_str ?? args.replace ?? args.new_text ?? "");
      if (so || sn) safe.replacements = [{ filePath: "", oldString: so, newString: sn }];
    }
    safe.explanation = String(args.explanation ?? "");
  } else if (/^create_file$/i.test(name)) {
    safe.filePath = _fixPathEscapes(
      String(args.filePath ?? args.file_path ?? args.path ?? args.filename ?? "")
    ).replace(/\\/g, "/");
    safe.content = String(args.content ?? args.contents ?? args.text ?? args.code ?? "");
    for (const k of Object.keys(args)) {
      if (!(k in safe)) safe[k] = args[k];
    }
  } else if (/^remove_file|delete_files?$/i.test(name)) {
    safe.filePath = _fixPathEscapes(
      String(args.filePath ?? args.path ?? args.filename ?? "")
    );
  } else if (/^run_command_in_terminal|execute_command$/i.test(name)) {
    safe.command = String(args.command ?? args.cmd ?? "");
    safe.summary = String(args.summary ?? args.description ?? "");
    safe.background =
      typeof args.background === "boolean"
        ? args.background
        : typeof args.runInBackground === "boolean"
        ? args.runInBackground
        : false;
    if (args.id != null) safe.id = String(args.id);
    if (args.explanation != null) safe.explanation = String(args.explanation);
    if (args.goal != null) safe.goal = String(args.goal);
    if (args.mode != null) safe.mode = String(args.mode);
    if (typeof args.isBackground === "boolean") safe.isBackground = args.isBackground;
    if (typeof args.timeout === "number") safe.timeout = args.timeout;
    if (typeof args.waitForOutput === "boolean") safe.waitForOutput = args.waitForOutput;
  } else if (/^get_background_terminal_output$/i.test(name)) {
    safe.terminal_id = _fixPathEscapes(
      String(args.terminal_id ?? args.terminalId ?? args.terminal ?? "")
    );
    safe.headLines = typeof args.headLines === "number" ? args.headLines : 0;
    safe.tailLines = typeof args.tailLines === "number" ? args.tailLines : 0;
    safe.stop = typeof args.stop === "boolean" ? args.stop : false;
    safe.waitMs =
      typeof args.waitMs === "number"
        ? args.waitMs
        : typeof args.timeout === "number"
        ? args.timeout
        : 0;
  } else if (/^get_terminal_output$/i.test(name)) {
    safe.id = String(args.id ?? args.terminal_id ?? "");
  } else if (/^kill_terminal$/i.test(name)) {
    safe.id = String(args.id ?? args.terminal_id ?? "");
  } else if (/^semantic_search$/i.test(name)) {
    safe.query = String(args.query ?? args.search ?? "");
  } else if (/^fetch_webpage$/i.test(name)) {
    safe.urls = args.urls ?? args.url ?? [];
    if (!Array.isArray(safe.urls)) safe.urls = [String(safe.urls ?? "")];
    safe.query = String(args.query ?? "");
  } else if (/^runSubagent$/i.test(name)) {
    safe.prompt = String(args.prompt ?? args.task ?? "");
    safe.description = String(args.description ?? args.desc ?? "");
    if (args.agentName != null) safe.agentName = String(args.agentName);
    if (args.model != null) safe.model = String(args.model);
  } else if (/^manage_todo_list$/i.test(name)) {
    safe.todoList = args.todoList ?? args.todos ?? [];
    if (!Array.isArray(safe.todoList)) safe.todoList = [safe.todoList];
  } else if (/^memory$/i.test(name)) {
    safe.command = String(args.command ?? "");
    if (args.path != null) safe.path = _fixPathEscapes(String(args.path));
    if (args.file_text != null) safe.file_text = String(args.file_text);
    if (args.old_str != null) safe.old_str = String(args.old_str);
    if (args.new_str != null) safe.new_str = String(args.new_str);
    if (typeof args.insert_line === "number") safe.insert_line = args.insert_line;
    if (args.insert_text != null) safe.insert_text = String(args.insert_text);
    if (args.view_range != null) safe.view_range = args.view_range;
    if (args.old_path != null) safe.old_path = String(args.old_path);
    if (args.new_path != null) safe.new_path = String(args.new_path);
  } else if (/^vscode_listCodeUsages$/i.test(name)) {
    safe.symbol = String(args.symbol ?? args.symbolName ?? args.query ?? "");
    safe.lineContent = String(args.lineContent ?? args.line ?? "");
    if (args.filePath != null) safe.filePath = _fixPathEscapes(String(args.filePath));
    if (args.uri != null) safe.uri = String(args.uri);
  } else if (/^vscode_renameSymbol$/i.test(name)) {
    safe.symbol = String(args.symbol ?? "");
    safe.newName = String(args.newName ?? args.new_name ?? "");
    safe.lineContent = String(args.lineContent ?? args.line ?? "");
    if (args.filePath != null) safe.filePath = _fixPathEscapes(String(args.filePath));
    if (args.uri != null) safe.uri = String(args.uri);
  } else if (/^vscode_askQuestions$/i.test(name)) {
    safe.questions = args.questions ?? args.question ?? [];
    if (!Array.isArray(safe.questions)) safe.questions = [String(safe.questions ?? "")];
  } else if (/^run_vscode_command$/i.test(name)) {
    safe.commandId = String(args.commandId ?? args.command ?? "");
    safe.name = String(args.name ?? "");
    if (args.args != null) safe.args = args.args;
    if (typeof args.skipCheck === "boolean") safe.skipCheck = args.skipCheck;
  } else if (/^create_and_run_task$/i.test(name)) {
    safe.task = String(args.task ?? "");
    safe.workspaceFolder = String(args.workspaceFolder ?? args.workspace ?? "");
  } else if (/^github_text_search$/i.test(name)) {
    safe.scope = String(args.scope ?? "repo");
    safe.query = String(args.query ?? args.search ?? "");
    if (typeof args.maxResults === "number") safe.maxResults = args.maxResults;
  } else if (/^github_repo$/i.test(name)) {
    safe.repo = String(args.repo ?? "");
    safe.query = String(args.query ?? "");
  } else if (
    /^(open_browser_page|read_page|navigate_page|click_element|type_in_page|hover_element|drag_element|handle_dialog|screenshot_page|run_playwright_code)$/i.test(
      name
    )
  ) {
    for (const [k, v] of Object.entries(args)) {
      if (v != null) safe[k] = v;
    }
  } else if (/^lookup_vs$/i.test(name)) {
    const rawTerms = args.terms ?? args.query ?? args.queries ?? args.search ?? args.searchTerms ?? "";
    safe.terms = Array.isArray(rawTerms) ? rawTerms.map(String) : [String(rawTerms)];
  } else if (/^ask_question$/i.test(name)) {
    // VS / VS Code ask-the-user tool. Accepts either an array of question
    // objects or a single string (LLMs often emit `{"questions": "..."}`).
    safe.questions = args.questions ?? args.question ?? [];
    if (!Array.isArray(safe.questions)) safe.questions = [String(safe.questions ?? "")];
    else safe.questions = safe.questions.map((q: any) => typeof q === "string" ? q : { ...q });
  } else if (/^get_projects_in_solution$/i.test(name)) {
    // VS solution enumeration — no args. Kimi K2.7 calls this with `{}`.
    // No coercion needed; ensure args is a valid empty object.
  } else if (/^get_files_in_project$/i.test(name)) {
    // VS project file enumeration. Takes a project identifier.
    safe.project = String(args.project ?? args.projectName ?? args.name ?? "");
  } else if (/^task_complete$/i.test(name)) {
    return tc;
  } else {
    return tc;
  }

  return {
    ...tc,
    function: { ...(tc.function || {}), name, arguments: JSON.stringify(safe) },
  };
}

// ── Stage B: JSON salvage fallback ─────────────────────────────────────────
//
// Called when `normalizeToolCall` returns null (JSON.parse failed). Regex-
// extracts whatever fields we can from the raw broken JSON.
//
// All complex regexes use `new RegExp()` constructor (rather than regex
// literals) to keep the TypeScript/esbuild parser happy. The unterminated-
// string fallback patterns (which match `"foo` without a closing quote)
// have unbalanced parens by design — the regex body ends mid-group and
// the regex literal `/` closes it implicitly.
export function salvageToolCall(tc: any): any | null {
  const name = (tc?.function?.name || "").trim();
  if (!name) return null;
  const raw = tc.function?.arguments;
  if (!raw) return null;
  const raw2 = String(raw);

  // Unescape common path damage so the regex doesn't see a stray `\\n` etc.
  // We re-escape `\\\\` (valid in JSON) so it doesn't get caught.
  const src = raw2
    .replace(/\\\\/g, "\x00")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\x00/g, "\\\\");

  try {
    if (/^create_file$/i.test(name)) {
      // Backtick form first (DeepSeek often uses template literals)
      const bt = _extract('"content"\\s*:\\s*`([\\s\\S]*?)`', src);
      let filePath =
        _extract('"(?:filePath|file_path|path|filename)"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', src) ||
        _extract('"(?:filePath|file_path|path|filename)"\\s*:\\s*`([^`]*)`', src);
      let content = bt;
      if (!content) {
        const ct = _extract('"content"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*?)"', src)
          || _extract('"content"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', src);
        if (ct) {
          content = ct.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        }
      }
      if (filePath) filePath = filePath.replace(/\\+/g, "/").replace(/\/{2,}/g, "/");
      if (filePath && content && content.length > 0) {
        return { ...tc, function: { ...tc.function, arguments: JSON.stringify({ filePath, content }) } };
      }
    }
    if (/^get_file$/i.test(name)) {
      const fn =
        _extract('"filename"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', src) ||
        _extract('"filename"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)', src);
      const filename = fn ? fn.replace(/\\+/g, "/").replace(/\/{2,}/g, "/") : "";
      const sl = _extract('"startLine"\\s*:\\s*(\\d+)', src);
      const el = _extract('"endLine"\\s*:\\s*(\\d+)', src);
      const safe: any = {
        filename,
        startLine: sl ? parseInt(sl, 10) : 1,
        endLine: el ? parseInt(el, 10) : 999999,
      };
      if (safe.endLine < safe.startLine) safe.endLine = safe.startLine + 1;
      if (filename) {
        return { ...tc, function: { ...tc.function, arguments: JSON.stringify(safe) } };
      }
    }
    if (/^read_file$/i.test(name)) {
      const fp =
        _extract('"(?:filePath|filepath|filename|path)"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', src) ||
        _extract('"(?:filePath|filepath|filename|path)"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)', src);
      const sl = _extract('"startLine"\\s*:\\s*(\\d+)', src);
      const el = _extract('"endLine"\\s*:\\s*(\\d+)', src);
      if (fp) {
        const filePath = fp.replace(/\\+/g, "/").replace(/\/{2,}/g, "/");
        return {
          ...tc,
          function: {
            ...tc.function,
            arguments: JSON.stringify({
              filePath,
              startLine: sl ? parseInt(sl, 10) : 1,
              endLine: el ? parseInt(el, 10) : 999999,
            }),
          },
        };
      }
    }
    if (/^replace_string_in_file$/i.test(name)) {
      const fp =
        _extract('"(?:filePath|filename|path|file)"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', src) ||
        _extract('"(?:filePath|filename|path|file)"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)', src);
      const os = _extract('"(?:oldString|old_string|old_str|old|search)"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*?)"', src)
        || _extract('"(?:oldString|old_string|old_str|old|search)"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)', src);
      const ns = _extract('"(?:newString|new_string|new_str|new|replace)"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*?)"', src)
        || _extract('"(?:newString|new_string|new_str|new|replace)"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)', src);
      if (fp) {
        const filePath = fp.replace(/\\+/g, "/").replace(/\/{2,}/g, "/");
        const oldString = os
          ? os.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
          : "";
        const newString = ns
          ? ns.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
          : "";
        if (oldString || newString) {
          return { ...tc, function: { ...tc.function, arguments: JSON.stringify({ filePath, oldString, newString }) } };
        }
      }
    }
    if (/^multi_replace_string_in_file$/i.test(name)) {
      const fp =
        _extract('"(?:filePath|filename|path|file)"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', src) ||
        _extract('"(?:filePath|filename|path|file)"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)', src);
      const os = _extract('"(?:oldString|old_string|old_str|old|search)"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*?)"', src)
        || _extract('"(?:oldString|old_string|old_str|old|search)"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)', src);
      const ns = _extract('"(?:newString|new_string|new_str|new|replace)"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*?)"', src)
        || _extract('"(?:newString|new_string|new_str|new|replace)"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)', src);
      if (fp) {
        const rep = {
          filePath: fp.replace(/\\+/g, "/").replace(/\/{2,}/g, "/"),
          oldString: os
            ? os.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
            : "",
          newString: ns
            ? ns.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
            : "",
        };
        return {
          ...tc,
          function: { ...tc.function, arguments: JSON.stringify({ replacements: [rep], explanation: "" }) },
        };
      }
    }
    if (/^(grep_search|search_content|search_file)$/i.test(name)) {
      const q =
        _extract('"query"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', src) ||
        _extract('"query"\\s*:\\s*([^,}\\s]+)', src);
      const query = q
        ? q.replace(/\\"/g, '"').replace(/\\\\/g, "\\").replace(/^"/, "")
        : "";
      const isRegexp = _test('"isRegexp"\\s*:\\s*true', src);
      let includePattern: string | null = null;
      const ipTerm = _extract('"includePattern"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', src);
      if (ipTerm) {
        includePattern = ipTerm;
      } else {
        const ipBare = _extract('"includePattern"\\s*:\\s*([^,}\\s]+)', src);
        if (ipBare && ipBare !== "null") includePattern = ipBare;
        else includePattern = null;
      }
      const mr = _extract('"maxResults"\\s*:\\s*(\\d+)', src);
      if (query || includePattern) {
        return {
          ...tc,
          function: {
            ...tc.function,
            arguments: JSON.stringify({
              query,
              isRegexp,
              includePattern,
              maxResults: mr ? parseInt(mr, 10) : null,
            }),
          },
        };
      }
    }
    if (/^(find_symbol|search_symbol)$/i.test(name)) {
      let symbolName =
        _extract('"symbolName"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', src) ||
        _extract('"symbolName"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)', src);
      if (!symbolName) {
        symbolName =
          _extract('"(?:query|symbol|name)"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', src) ||
          _extract('"(?:query|symbol|name)"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)', src);
      }
      const nt = _extract('"navigationType"\\s*:\\s*(\\d+)', src);
      const fp =
        _extract('"(?:filepath|filePath|filename)"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', src) ||
        _extract('"(?:filepath|filePath|filename)"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)', src);
      const lt =
        _extract('"lineText"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', src) ||
        _extract('"lineText"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)', src);
      if (symbolName) {
        return {
          ...tc,
          function: {
            ...tc.function,
            arguments: JSON.stringify({
              symbolName: symbolName.replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
              navigationType: nt ? parseInt(nt, 10) : 1,
              filepath: fp ? fp.replace(/\\+/g, "/").replace(/\/{2,}/g, "/") : "",
              lineText: lt ? lt.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : "",
            }),
          },
        };
      }
    }
    if (/^(run_command_in_terminal|execute_command)$/i.test(name)) {
      const cmd =
        _extract('"command"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', src) ||
        _extract('"command"\\s*:\\s*([^,}]+?)(?=\\s*,\\s*"|\\s*}$|$)', src);
      const sum =
        _extract('"summary"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', src) ||
        _extract('"summary"\\s*:\\s*([^,}]+?)(?=\\s*,\\s*"|\\s*}$|$)', src);
      const background = _test('"background"\\s*:\\s*true', src);
      if (cmd) {
        return {
          ...tc,
          function: {
            ...tc.function,
            arguments: JSON.stringify({
              command: cmd.replace(/\\"/g, '"').replace(/\\\\/g, "\\").trim(),
              summary: sum ? sum.replace(/\\"/g, '"').replace(/\\\\/g, "\\").trim() : "",
              background,
            }),
          },
        };
      }
    }
    if (/^(run_in_terminal|send_to_terminal)$/i.test(name)) {
      const cmd =
        _extract('"command"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', src) ||
        _extract('"command"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*?)"', src);
      const id =
        _extract('"id"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', src) ||
        _extract('"id"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*?)"', src);
      const exp =
        _extract('"explanation"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', src) ||
        _extract('"explanation"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*?)"', src);
      if (cmd) {
        const safe: any = { command: cmd.replace(/\\"/g, '"').replace(/\\\\/g, "\\") };
        if (id) safe.id = id.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        if (exp) safe.explanation = exp.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        return { ...tc, function: { ...tc.function, arguments: JSON.stringify(safe) } };
      }
    }
    if (/^plan$/i.test(name)) {
      const pm = _extract('"planMarkdown"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*?)"', src)
        || _extract('"planMarkdown"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)', src);
      if (pm) {
        const planMarkdown = pm
          .replace(/\\n/g, "\n")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
        if (planMarkdown.length > 0) {
          return { ...tc, function: { ...tc.function, arguments: JSON.stringify({ planMarkdown }) } };
        }
      }
    }
    if (/^(code_search|search_code|semantic_search)$/i.test(name)) {
      let queries: string[] = [];
      const sq = _extract('"searchQueries"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*?)"', src);
      if (sq) {
        queries = [sq.replace(/\\"/g, '"').replace(/\\\\/g, "\\")];
      } else {
        const q = _extract('"queries"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', src);
        if (q) queries = [q.replace(/\\"/g, '"').replace(/\\\\/g, "\\")];
      }
      if (!queries.length) {
        const unq = _extract('"searchQueries"\\s*:\\s*"?\\s*([^"}]+)', src);
        if (unq) queries = [unq.replace(/\\"/g, '"').replace(/\\\\/g, "\\").trim()];
      }
      if (queries.length) {
        return { ...tc, function: { ...tc.function, arguments: JSON.stringify({ searchQueries: queries }) } };
      }
    }
    if (/^(file_search|search_files|find_files|glob_search|list_files)$/i.test(name)) {
      const queries: string[] = [];
      const qArr = new RegExp('"queries"\\s*:\\s*\\[(.*?)(?:\\]|$)', "s").exec(src);
      if (qArr) {
        const inner = qArr[1];
        const sqRe = new RegExp('"((?:[^"\\\\]|\\\\.)*)"', "g");
        let sq: RegExpExecArray | null;
        while ((sq = sqRe.exec(inner))) queries.push(sq[1]);
      }
      if (!queries.length) {
        const unq = _extract('"queries"\\s*:\\s*\\[?\\s*([^"\\],]+)', src);
        if (unq) {
          const vals = unq.split(/[\s,]+/).filter((v) => v && v !== "null");
          for (const v of vals) queries.push(v);
        }
      }
      const mr = _extract('"maxResults"\\s*:\\s*(\\d+)', src);
      if (queries.length) {
        return {
          ...tc,
          function: {
            ...tc.function,
            arguments: JSON.stringify({ queries, maxResults: mr ? parseInt(mr, 10) : 20 }),
          },
        };
      }
    }
    if (/^lookup_vs$/i.test(name)) {
      let terms: string[] = [];
      const tArr = new RegExp('"terms"\\s*:\\s*\\[(.*?)(?:\\]|$)', "s").exec(src);
      if (tArr) {
        const inner = tArr[1];
        const sRe = new RegExp('"((?:[^"\\\\]|\\\\.)*)"', "g");
        let sm: RegExpExecArray | null;
        while ((sm = sRe.exec(inner))) terms.push(sm[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
      }
      if (!terms.length) {
        const single = _extract('"terms"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', src);
        if (single) terms = [single.replace(/\\"/g, '"').replace(/\\\\/g, "\\")];
      }
      if (terms.length) {
        return { ...tc, function: { ...tc.function, arguments: JSON.stringify({ terms }) } };
      }
    }
  } catch {
    // fall through
  }
  return null;
}

// ── Combined entry: try normalize, fall back to salvage ────────────────────
//
// Returns the salvaged/normalized tool call, or `null` if it cannot be
// recovered (caller should drop it or substitute `task_complete`).
export function repairToolCall(tc: any): any | null {
  if (!tc || !tc.function) return null;
  const norm = normalizeToolCall(tc);
  if (norm) return norm;
  return salvageToolCall(tc);
}

// ── Repair an entire list of upstream tool_calls ──────────────────────────
//
// Returns `{ repaired, dropped, total }`. Caller can iterate `repaired` and
// handle `dropped` separately (typically by injecting a `task_complete`).
export function repairToolCalls(toolCalls: any[]): {
  repaired: any[];
  dropped: any[];
  total: number;
} {
  const repaired: any[] = [];
  const dropped: any[] = [];
  for (const tc of toolCalls || []) {
    const r = repairToolCall(tc);
    if (r) repaired.push(r);
    else dropped.push(tc);
  }
  return { repaired, dropped, total: toolCalls?.length || 0 };
}

// ── Apology / refusal text detection ───────────────────────────────────────
//
// Returns true if the LLM's assistant text is a refusal or "I can't" pattern
// rather than a genuine answer. When the LLM apologizes instead of calling
// a tool (or after calling a tool), the user sees a stuck/incomplete result
// — we auto-substitute `task_complete` so VS finalizes the turn.
//
// Patterns captured from real upstream outputs:
//   - "I apologize, but I'm unable to retrieve the contents of the selected code to explain it."
//   - "I'm sorry, but I can't ..."
//   - "I cannot ..."
//   - "Unfortunately, I don't have access ..."
//   - "As an AI, I ..."
//   - "I am unable to ..."
const APOLOGY_PATTERNS: RegExp[] = [
  /\bi\s+(apologize|am\s+sorry|can't|cannot|am\s+unable|don't\s+have|do\s+not\s+have|am\s+not\s+able)/i,
  /\b(unfortunately|sorry),\s+(but\s+)?(i\s+)?(can't|cannot|am\s+unable|don't\s+have|do\s+not)/i,
  /\bas\s+an?\s+ai\s+(language\s+model|assistant|model)/i,
  /\bi'?m\s+just\s+an?\s+ai/i,
  /\bno\s+specific\s+(code\s+range|selection|code\s+snippet)\s+(was\s+)?(provided|given|selected|specified)/i,
  /\bi\s+would\s+need\s+(more\s+)?(context|information|details)\s+to\s+(help|proceed|answer)/i,
  /\bactive\s+file\s+is\s+.+?\s*,?\s*but\s+no\s+specific/i,
];

export function detectApologyText(text: string | undefined | null): boolean {
  if (!text || typeof text !== "string") return false;
  const t = text.trim();
  if (t.length === 0 || t.length > 4000) return false;
  if (t.split(/\s+/).length < 4) return false;
  for (const re of APOLOGY_PATTERNS) {
    if (re.test(t)) return true;
  }
  return false;
}

// ── Tool-call loop detection ───────────────────────────────────────────────
//
// Walks recent assistant messages looking for the same tool name+args combo.
// If the same tool is called N+ times in a row (regardless of whether args
// are identical or just close), the model is stuck and we break the loop.
//
// Returns `{ inLoop, count, lastCall }` where `count` is how many of the
// most-recent assistant messages called this tool.
const LOOP_WINDOW = 4;       // look at last N assistant messages
const LOOP_THRESHOLD = 3;    // fire task_complete if ≥3 of them called same tool

export function detectToolLoop(
  messages: any[],
  candidate: { name: string; arguments: any } | null = null
): { inLoop: boolean; count: number; tool: string; args: string } {
  const fallback = { inLoop: false, count: 0, tool: "", args: "" };
  if (!Array.isArray(messages) || !messages.length) return fallback;

  // Collect last N assistant tool_calls
  const recent: { name: string; args: string }[] = [];
  for (let i = messages.length - 1; i >= 0 && recent.length < LOOP_WINDOW; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const tcs = m.tool_calls || [];
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type === "tool_use" && b.name) {
          recent.push({ name: b.name, args: JSON.stringify(b.input || {}) });
        }
      }
    }
    for (const tc of tcs) {
      const fn = tc.function || tc;
      const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {});
      if (fn.name) recent.push({ name: fn.name, args });
    }
    if (tcs.length === 0 && !(Array.isArray(m.content) && m.content.some((c: any) => c.type === "tool_use"))) {
      break;
    }
  }

  if (candidate && candidate.name) {
    recent.unshift({ name: candidate.name, args: JSON.stringify(candidate.arguments || {}) });
  }

  if (!recent.length) return fallback;

  const first = recent[0];
  let count = 0;
  for (const r of recent) {
    if (r.name === first.name && r.args === first.args) count++;
    else break;
  }

  let fuzzyCount = 0;
  for (const r of recent) {
    if (r.name === first.name) fuzzyCount++;
    else break;
  }

  const inLoop = fuzzyCount >= LOOP_THRESHOLD;
  return { inLoop, count: fuzzyCount, tool: first.name, args: first.args };
}

// ── task_complete builder ─────────────────────────────────────────────────
//
// Builds a synthetic tool_use block for `task_complete` — VS-only sentinel
// that signals "I'm done, stop nagging me." Returns the JSON-serialized SSE
// for Anthropic Messages API, and a separate function for OpenAI tool_calls.
export function buildAnthropicTaskComplete(model: string): string {
  const id = `msg_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
  const toolId = `toolu_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
  return [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: toolId, name: "task_complete", input: {} },
    })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({
      type: "content_block_stop",
      index: 0,
    })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { input_tokens: 0, output_tokens: 0 },
    })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ].join("");
}

export function buildOpenAITaskComplete(model: string): any {
  return {
    id: `chatcmpl-${forge.util.bytesToHex(forge.random.getBytesSync(6))}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call_${forge.util.bytesToHex(forge.random.getBytesSync(6))}`,
              type: "function",
              function: { name: "task_complete", arguments: "{}" },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export function buildResponsesTaskComplete(model: string): any {
  return {
    id: `resp_${forge.util.bytesToHex(forge.random.getBytesSync(6))}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "" }],
      },
    ],
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

// ── Diagnostic counters (for logs / dashboard) ────────────────────────────
let _salvageStats = {
  normalized: 0,
  salvaged: 0,
  dropped: 0,
  apologyInjected: 0,
  loopInjected: 0,
  lastAt: 0,
};

export function bumpSalvageStat(kind: "normalized" | "salvaged" | "dropped" | "apologyInjected" | "loopInjected") {
  _salvageStats[kind]++;
  _salvageStats.lastAt = Date.now();
}

export function getSalvageStats() {
  return { ..._salvageStats };
}
