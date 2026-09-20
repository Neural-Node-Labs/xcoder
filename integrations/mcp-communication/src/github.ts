/**
 * GitHub tools, via the REST API with a personal access token.
 *
 * Scope note: a classic PAT needs `repo` for private repositories (and to comment), or just
 * `public_repo` if you only ever touch public ones. A fine-grained token needs Contents: Read,
 * Issues: Read and write, and Metadata: Read. Least privilege genuinely matters here — this
 * token is handed to a model-driven tool surface, so grant the narrowest set that covers what
 * you actually want it doing.
 */

import { apiFetch, requireEnv, ToolError, truncate } from "./core.js";

const API = "https://api.github.com";

const TOKEN_HINT =
  "Create a token at https://github.com/settings/tokens. Classic: `repo` (or `public_repo`). " +
  "Fine-grained: Contents=Read, Issues=Read+Write, Metadata=Read.";

function gh<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = requireEnv("GITHUB_TOKEN", TOKEN_HINT);
  return apiFetch<T>(`${API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mcp-communication",
    },
  });
}

/** Splits "owner/repo" and fails clearly rather than producing a confusing 404 later. */
function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = (repo ?? "").split("/");
  if (!owner || !name) throw new ToolError(`repo must be in "owner/name" form, got "${repo}".`);
  return { owner, name };
}

export async function githubSearchRepos(args: { query: string; maxResults?: number }) {
  if (!args.query) throw new ToolError("query is required.");
  const params = new URLSearchParams({ q: args.query, per_page: String(Math.min(args.maxResults ?? 10, 50)) });
  const res = await gh<{ items?: { full_name: string; description?: string; stargazers_count: number; html_url: string; language?: string }[] }>(
    `/search/repositories?${params}`
  );
  if (!res.items?.length) return "No repositories matched.";
  return truncate(
    res.items
      .map((r) => `${r.full_name} (★${r.stargazers_count}${r.language ? `, ${r.language}` : ""})\n${r.description ?? ""}\n${r.html_url}`)
      .join("\n---\n")
  );
}

export async function githubListIssues(args: { repo: string; state?: "open" | "closed" | "all"; labels?: string; maxResults?: number }) {
  const { owner, name } = splitRepo(args.repo);
  const params = new URLSearchParams({
    state: args.state ?? "open",
    per_page: String(Math.min(args.maxResults ?? 20, 100)),
  });
  if (args.labels) params.set("labels", args.labels);

  const issues = await gh<{ number: number; title: string; state: string; user?: { login: string }; labels?: { name: string }[]; html_url: string; pull_request?: unknown }[]>(
    `/repos/${owner}/${name}/issues?${params}`
  );
  if (!issues.length) return "No issues matched.";

  return truncate(
    issues
      .map((i) =>
        [
          // GitHub's issues endpoint also returns PRs; flag them so they aren't mistaken for issues.
          `#${i.number}${i.pull_request ? " [pull request]" : ""}: ${i.title}`,
          `state: ${i.state}`,
          `author: ${i.user?.login ?? "?"}`,
          i.labels?.length ? `labels: ${i.labels.map((l) => l.name).join(", ")}` : "",
          i.html_url,
        ].filter(Boolean).join("\n")
      )
      .join("\n---\n")
  );
}

export async function githubGetIssue(args: { repo: string; issueNumber: number }) {
  const { owner, name } = splitRepo(args.repo);
  if (!args.issueNumber) throw new ToolError("issueNumber is required.");

  const issue = await gh<{ number: number; title: string; body?: string; state: string; user?: { login: string }; html_url: string }>(
    `/repos/${owner}/${name}/issues/${args.issueNumber}`
  );
  const comments = await gh<{ user?: { login: string }; body?: string; created_at: string }[]>(
    `/repos/${owner}/${name}/issues/${args.issueNumber}/comments?per_page=30`
  );

  const parts = [
    `#${issue.number}: ${issue.title}`,
    `state: ${issue.state}  author: ${issue.user?.login ?? "?"}`,
    issue.html_url,
    "",
    issue.body ?? "(no description)",
  ];
  if (comments.length) {
    parts.push("", `--- ${comments.length} comment(s) ---`);
    for (const c of comments) parts.push("", `${c.user?.login ?? "?"} at ${c.created_at}:`, c.body ?? "");
  }
  return truncate(parts.join("\n"));
}

export async function githubCreateIssue(args: { repo: string; title: string; body?: string; labels?: string[] }) {
  const { owner, name } = splitRepo(args.repo);
  if (!args.title) throw new ToolError("title is required.");
  const created = await gh<{ number: number; html_url: string }>(`/repos/${owner}/${name}/issues`, {
    method: "POST",
    body: { title: args.title, body: args.body, labels: args.labels },
  });
  return `Created issue #${created.number}: ${created.html_url}`;
}

export async function githubComment(args: { repo: string; issueNumber: number; body: string }) {
  const { owner, name } = splitRepo(args.repo);
  if (!args.issueNumber || !args.body) throw new ToolError("issueNumber and body are required.");
  const created = await gh<{ html_url: string }>(`/repos/${owner}/${name}/issues/${args.issueNumber}/comments`, {
    method: "POST",
    body: { body: args.body },
  });
  return `Comment posted: ${created.html_url}`;
}

export async function githubReadFile(args: { repo: string; path: string; ref?: string }) {
  const { owner, name } = splitRepo(args.repo);
  if (!args.path) throw new ToolError("path is required.");
  const params = args.ref ? `?ref=${encodeURIComponent(args.ref)}` : "";

  const file = await gh<{ content?: string; encoding?: string; size: number; type: string; name: string }>(
    `/repos/${owner}/${name}/contents/${args.path}${params}`
  );
  if (file.type !== "file") throw new ToolError(`"${args.path}" is a ${file.type}, not a file.`);
  if (file.encoding !== "base64" || !file.content) {
    throw new ToolError(`"${args.path}" could not be decoded (encoding: ${file.encoding ?? "unknown"}). Files over 1MB need the Git blob API instead.`);
  }
  return truncate(Buffer.from(file.content, "base64").toString("utf-8"));
}
