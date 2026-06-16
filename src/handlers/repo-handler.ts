import { jsonResponse, HandlerInput, HandlerResult, getGithubUsername } from "../shared.ts";

export function handleRepo(req: HandlerInput): HandlerResult {
  const { method, url, body } = req;
  const ghUser = getGithubUsername();

  // POST /repos/*/issues - Create issue (feedback/telemetry)
  if (method === "POST" && url.match(/\/repos\/[^/]+\/[^/]+\/issues$/)) {
    console.log(`\n[FAKE GHE] Intercepting issue creation: ${url}`);
    const repoMatch = url.match(/\/repos\/([^/]+)\/([^/]+)\/issues/);
    const owner = repoMatch ? repoMatch[1] : "github";
    const repo = repoMatch ? repoMatch[2] : "app";
    let parsedBody: any = {};
    try { parsedBody = JSON.parse(body?.toString() || "{}"); } catch {}
    const title = parsedBody.title || "Feedback";
    const now = new Date().toISOString();
    return { handled: true, response: jsonResponse({
      id: Math.floor(Math.random() * 900000) + 100000,
      node_id: `MDU6SXNzdWUx${Math.floor(Math.random() * 999)}`,
      number: Math.floor(Math.random() * 9000) + 1000,
      title, state: "open", locked: false,
      body: parsedBody.body || null,
      html_url: `https://github.com/${owner}/${repo}/issues/1`,
      url: `https://api.github.com/repos/${owner}/${repo}/issues/1`,
      repository_url: `https://api.github.com/repos/${owner}/${repo}`,
      labels_url: `https://api.github.com/repos/${owner}/${repo}/issues/1/labels{/name}`,
      comments_url: `https://api.github.com/repos/${owner}/${repo}/issues/1/comments`,
      events_url: `https://api.github.com/repos/${owner}/${repo}/issues/1/events`,
      labels: [], assignee: null, assignees: [], milestone: null,
      comments: 0, created_at: now, updated_at: now, closed_at: null,
      author_association: "NONE", active_lock_reason: null, draft: false, state_reason: null,
      user: { login: getGithubUsername(), id: 99999999, avatar_url: "https://avatars.githubusercontent.com/u/99999999?v=4", type: "User" },
      reactions: { url: `https://api.github.com/repos/${owner}/${repo}/issues/1/reactions`, total_count: 0, "+1": 0, "-1": 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
    }, 201)};
  }

  // POST /repos/*/issues/*/comments - Issue comment
  if (method === "POST" && url.match(/\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments/)) {
    const repoMatch = url.match(/\/repos\/([^/]+)\/([^/]+)\/issues/);
    const owner = repoMatch ? repoMatch[1] : "github";
    const repo = repoMatch ? repoMatch[2] : "app";
    const now = new Date().toISOString();
    return { handled: true, response: jsonResponse({
      id: 1, node_id: "MDEyOklzc3VlQ29tbWVudDE", body: "ok",
      html_url: `https://github.com/${owner}/${repo}/issues/1#issuecomment-1`,
      url: `https://api.github.com/repos/${owner}/${repo}/issues/comments/1`,
      created_at: now, updated_at: now, author_association: "NONE",
      user: { login: getGithubUsername(), id: 99999999, avatar_url: "https://avatars.githubusercontent.com/u/99999999?v=4", type: "User" },
      reactions: { url: `https://api.github.com/repos/${owner}/${repo}/issues/comments/1/reactions`, total_count: 0 },
    }, 201)};
  }

  // POST /repos/*/issues/*/reactions - Issue reaction
  if (method === "POST" && url.match(/\/repos\/[^/]+\/[^/]+\/issues\/\d+\/reactions/)) {
    return { handled: true, response: jsonResponse({ id: 1, content: "heart", created_at: new Date().toISOString() }, 200) };
  }

  // GET /repos/*/releases/assets/* or /repos/*/releases/download/* - Asset download
  if (method === "GET" && (url.includes("/releases/assets") || url.includes("/releases/download"))) {
    console.log(`\n[FAKE GHE] Intercepting release asset: ${url}`);
    return { handled: true, response: {
      statusCode: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" },
      body: Buffer.from(JSON.stringify({
        version: "0.2.6", notes: "Fake release for local dev", pub_date: new Date().toISOString(),
        platforms: {
          "windows-x86_64-msi": { signature: "", url: "https://github.com/github/app/releases/download/v0.2.6/GitHub-Copilot-windows-x64-setup.exe" },
          "windows-x86_64": { signature: "", url: "https://github.com/github/app/releases/download/v0.2.6/GitHub-Copilot-windows-x64-setup.exe" },
          "darwin-x86_64": { signature: "", url: "https://github.com/github/app/releases/download/v0.2.6/GitHub-Copilot-x64.dmg" },
          "darwin-aarch64": { signature: "", url: "https://github.com/github/app/releases/download/v0.2.6/GitHub-Copilot-aarch64.dmg" },
          "linux-x86_64": { signature: "", url: "https://github.com/github/app/releases/download/v0.2.6/GitHub-Copilot-x86_64.AppImage" },
        },
      })),
    }};
  }

  // GET /repos/*/releases/latest - Version check
  if (method === "GET" && url.includes("/releases/latest")) {
    console.log(`\n[FAKE GHE] Intercepting release check: ${url}`);
    const now = new Date().toISOString();
    return { handled: true, response: jsonResponse({
      url: "https://api.github.com/repos/github/app/releases/324616210",
      assets_url: "https://api.github.com/repos/github/app/releases/324616210/assets",
      html_url: "https://github.com/github/app/releases/tag/v0.2.6",
      id: 324616210, node_id: "RE_kwDOAAAAAA", tag_name: "v0.2.6", target_commitish: "main",
      name: "v0.2.6", draft: false, prerelease: false, created_at: now, published_at: now,
      assets: (() => {
        const names = ["latest.json", "GitHub-Copilot-windows-x64-setup.exe", "GitHub-Copilot-x64.dmg", "GitHub-Copilot-aarch64.dmg", "GitHub-Copilot-x86_64.AppImage"];
        const contentTypes = ["application/json", "application/x-msi", "application/x-apple-diskimage", "application/x-apple-diskimage", "application/octet-stream"];
        return Array.from({ length: names.length }, (_, i) => {
          return {
            url: `https://api.github.com/repos/github/app/releases/assets/${423673592 - i}`,
            id: 423673592 - i, name: names[i], content_type: contentTypes[i], state: "uploaded",
            size: 200 + i * 1000, download_count: 0, created_at: now, updated_at: now,
            browser_download_url: `https://github.com/github/app/releases/download/v0.2.6/${names[i]}`,
          };
        });
      })(),
      body: "Fake release for local dev",
      author: { login: ghUser, id: 99999999, avatar_url: "https://avatars.githubusercontent.com/u/99999999?v=4", type: "User" },
    })};
  }

  // GET/POST /repos/*/git/blobs - Git blob operations
  if ((method === "GET" || method === "POST") && url.match(/\/repos\/[^/]+\/[^/]+\/git\/blobs/)) {
    if (method === "GET") {
      return { handled: true, response: jsonResponse({ sha: "abc123", node_id: "blob_abc", size: 0, content: "", encoding: "base64" }) };
    }
    return { handled: true, response: jsonResponse({ sha: "abc123", node_id: "blob_abc" }, 201) };
  }

  // GET /repos/*/git/trees/* - Git tree
  if (method === "GET" && url.match(/\/repos\/[^/]+\/[^/]+\/git\/trees\/?/)) {
    return { handled: true, response: jsonResponse({ sha: "abc123", url: "", tree: [], truncated: false }) };
  }

  // GET /repos/*/git/refs/* - Git references
  if (method === "GET" && url.match(/\/repos\/[^/]+\/[^/]+\/git\/refs\/?/)) {
    return { handled: true, response: jsonResponse([{ ref: "refs/heads/main", node_id: "ref_abc", url: "", object: { sha: "abc123", type: "commit", url: "" } }]) };
  }

  // GET /repos/*/contents/* - File contents
  if (method === "GET" && url.match(/\/repos\/[^/]+\/[^/]+\/contents\//)) {
    return { handled: true, response: jsonResponse({
      name: "README.md", path: "README.md", sha: "abc123", size: 0,
      type: "file", content: "", encoding: "base64",
      html_url: "", url: "", git_url: "", download_url: "",
      _links: { self: "", git: "", html: "" },
    })};
  }

  // GET /repos/*/branches - List branches
  if (method === "GET" && url.match(/\/repos\/[^/]+\/[^/]+\/branches(\?|$)/)) {
    return { handled: true, response: jsonResponse([
      { name: "main", commit: { sha: "abc123", url: "" }, protected: false, protection_url: "" },
      { name: "develop", commit: { sha: "def456", url: "" }, protected: false, protection_url: "" },
    ])};
  }

  // GET /repos/*/branches/* - Specific branch
  if (method === "GET" && url.match(/\/repos\/[^/]+\/[^/]+\/branches\/[^/]+$/)) {
    const branchName = url.split("/branches/")[1]?.split(/[?#]/)[0] || "main";
    return { handled: true, response: jsonResponse({
      name: branchName, commit: { sha: "abc123", url: "" },
      protected: false, protection_url: "",
      _links: { self: "", html: "" },
    })};
  }

  // GET /repos/*/commits - List commits
  if (method === "GET" && url.match(/\/repos\/[^/]+\/[^/]+\/commits(\?|$)/)) {
    return { handled: true, response: jsonResponse([]) };
  }

  // GET /repos/*/commits/* - Specific commit
  if (method === "GET" && url.match(/\/repos\/[^/]+\/[^/]+\/commits\/[^/]+$/)) {
    const now = new Date().toISOString();
    return { handled: true, response: jsonResponse({
      sha: "abc123", node_id: "commit_abc", commit: { message: "Fake commit", author: { name: "Fake User", email: "fake@example.com", date: now }, committer: { name: "Fake User", email: "fake@example.com", date: now }, tree: { sha: "def456" } },
      url: "", html_url: "", comments_url: "", author: null, committer: null, parents: [],
      stats: { total: 0, additions: 0, deletions: 0 }, files: [],
    })};
  }

  // GET /repos/*/pulls - List pull requests
  if (method === "GET" && url.match(/\/repos\/[^/]+\/[^/]+\/pulls(\?|$)/)) {
    return { handled: true, response: jsonResponse([]) };
  }

  // GET /repos/*/pulls/* - Specific pull request
  if (method === "GET" && url.match(/\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/)) {
    const now = new Date().toISOString();
    return { handled: true, response: jsonResponse({
      id: 1, number: 1, state: "open", title: "Fake PR", body: "Fake PR body",
      html_url: "", url: "", diff_url: "", patch_url: "", issue_url: "",
      created_at: now, updated_at: now, closed_at: null, merged_at: null,
      head: { label: `${ghUser}:feature`, ref: "feature", sha: "abc123", repo: null },
      base: { label: `${ghUser}:main`, ref: "main", sha: "def456", repo: null },
      user: { login: ghUser, id: 99999999, type: "User" },
      draft: false, merged: false, mergeable: true, rebaseable: true, mergeable_state: "clean",
      merged_by: null, comments: 0, review_comments: 0, commits: 0, additions: 0, deletions: 0, changed_files: 0,
    })};
  }

  // GET /repos/*/stats/* - Repository statistics
  if (method === "GET" && url.match(/\/repos\/[^/]+\/[^/]+\/stats\//)) {
    return { handled: true, response: jsonResponse([]) };
  }

  // GET /repos/*/collaborators - Collaborators
  if (method === "GET" && url.match(/\/repos\/[^/]+\/[^/]+\/collaborators(\?|$)/)) {
    return { handled: true, response: jsonResponse([]) };
  }

  // GET /repos/*/collaborators/*/permission - Permission check
  if (method === "GET" && url.match(/\/repos\/[^/]+\/[^/]+\/collaborators\/[^/]+\/permission/)) {
    return { handled: true, response: jsonResponse({ permission: "admin", user: { login: ghUser, id: 99999999, type: "User" } }) };
  }

  // GET /repos/*/hooks - Webhooks
  if (method === "GET" && url.match(/\/repos\/[^/]+\/[^/]+\/hooks(\?|$)/)) {
    return { handled: true, response: jsonResponse([]) };
  }

  // POST /repos/*/forks - Fork repo
  if (method === "POST" && url.match(/\/repos\/[^/]+\/[^/]+\/forks/)) {
    const now = new Date().toISOString();
    return { handled: true, response: jsonResponse({
      id: 99999999, name: "forked-repo", full_name: `${ghUser}/forked-repo`,
      private: false, owner: { login: ghUser, id: 99999999, type: "User" },
      html_url: `https://github.com/${ghUser}/forked-repo`,
      description: "Forked repo", fork: true,
      created_at: now, updated_at: now, pushed_at: now,
      default_branch: "main", visibility: "public",
    }, 202)};
  }

  // GET /repos/*/tags - List tags
  if (method === "GET" && url.match(/\/repos\/[^/]+\/[^/]+\/tags(\?|$)/)) {
    return { handled: true, response: jsonResponse([]) };
  }

  // PUT /repos/*/git/refs/* - Create or update git reference
  if (method === "POST" && url.match(/\/repos\/[^/]+\/[^/]+\/git\/refs/)) {
    return { handled: true, response: jsonResponse({ ref: "refs/heads/main", node_id: "ref_abc", url: "", object: { sha: "abc123", type: "commit", url: "" } }, 201) };
  }

  // Catch-all for any /repos/* endpoint not matched above
  if (method === "GET" && url.startsWith("/repos/")) {
    console.log(`\n[FAKE GHE] Repo catch-all: ${url}`);
    return { handled: true, response: jsonResponse({}) };
  }

  return { handled: false };
}
