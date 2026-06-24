// VS-Shell: unified handler for VS-family clients.
// Auth (copilot_internal/*, OAuth passthrough) is handled here.
// Chat / models / completions are delegated to handlers/vs/*.
//
// This replaces the old split between handlers/vs/auth.ts (VS Copilot
// Client, editor-version based) and handlers/ssms/* (VS Team
// Explorer, user-agent based). Both share the same OAuth flow, so a
// single auth handler covers them.
export { handleVSShell, isVSShell, isVSOAuthFlow, VS_CLIENT_ID, VS_REDIRECT_URI_PREFIX } from "./auth.ts";
