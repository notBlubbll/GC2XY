import { HandlerInput, HandlerResult, htmlResponse, getGithubUsername } from "../../shared.ts";
import { isGHCPApp } from "./auth.ts";
import { handleGHCPModels } from "./models.ts";
import { trackRequest } from "../../usage-tracker.ts";

export function handleGHCPApp(req: HandlerInput): Promise<HandlerResult> {
  trackRequest("ghcp");
  return _handleGHCPApp(req);
}

// GHCP feedback page — opened in browser when user clicks feedback in GitHub Desktop
function _handleGHCPFeedback(req: HandlerInput): HandlerResult {
  const { method, url } = req;
  if (method !== "GET") return { handled: false };
  if (!url.includes("/github/app/discussions") && !url.includes("/github/github-app/discussions")) {
    return { handled: false };
  }
  console.log(`\n[GHCP APP] Feedback page: ${url}`);
  return {
    handled: true,
    response: htmlResponse(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>GitHub Discussions — Feedback</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#e6edf3;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;}
.box{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:40px;max-width:500px;text-align:center;}
h1{margin-top:0;}.btn{display:inline-block;padding:8px 20px;background:#238636;color:#fff;border-radius:6px;text-decoration:none;margin-top:16px;}
p{color:#8b949e;line-height:1.5;}
a{color:#58a6ff;}</style></head>
<body><div class="box">
<h1>💬 GitHub Desktop Feedback</h1>
<p>Thank you for using GitHub Desktop!<br>
Your feedback helps us improve the experience.</p>
<p>This is a mock feedback page served by the MITM debug proxy (gc2xy).<br>
In production, this would connect to the real GitHub Discussions.</p>
<a class="btn" href="https://github.com/github/desktop/discussions" target="_blank">Go to Discussions</a>
<p style="margin-top:24px;font-size:12px;">gc2xy — MITM Debug Proxy</p>
</div></body></html>`),
  };
}

export async function _handleGHCPApp(req: HandlerInput): Promise<HandlerResult> {
  // Check feedback/discussions page first (regardless of UA — opened in browser)
  const feedbackResult = _handleGHCPFeedback(req);
  if (feedbackResult.handled) return feedbackResult;

  if (!isGHCPApp(req)) return { handled: false };

  // GHCP-specific model list
  const modelsResult = await handleGHCPModels(req);
  if (modelsResult.handled) return modelsResult;

  // Autopilot team membership check — fake user is always a member
  if (req.method === "GET" && req.url.match(/\/orgs\/github\/teams\/autopilot\/memberships\//)) {
    const username = req.url.split("/").pop() || getGithubUsername();
    return { handled: true, response: { statusCode: 200, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" }, body: Buffer.from(JSON.stringify({ url: `https://api.github.com/orgs/github/teams/autopilot/memberships/${username}`, role: "member", state: "active" })) } };
  }

  return { handled: false };
}
