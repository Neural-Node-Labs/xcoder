import fs from "node:fs";
import path from "node:path";
import { resolveTaskHistoryJsonlPath, resolveTaskHistoryMarkdownPath } from "../config/paths.js";

const MAX_ENTRIES = 200; // cap file growth; oldest entries drop off on append past this
const MAX_MARKDOWN_ENTRIES = 50;

export interface TaskHistoryEntry {
  id: string;
  task: string;
  summary: string;
  timestamp: string; // ISO 8601
  iterations: number;
  totalTokens?: number;
}

/**
 * Idinadagdag ang isang nakumpletong top-level na task sa .agent/tasks/task-history.jsonl AT
 * .agent/tasks/task_history.md (hindi kailanman tinatawag para sa mga subagent run — ang mga
 * iyon ay internal implementation detail, hindi bagay na tatawagin ng isang user na "ang huling
 * task"). Sadyang HINDI ito binabasa pabalik sa `messages` kahit saan sa orchestrator.ts — ang
 * tanging paraan para maabot ng model ang data na ito ay kung tahasan itong tatawag sa
 * task_history_tool, ayon sa layunin ng disenyo na panatilihin itong wala sa default context
 * habang nananatiling queryable kung kailangan.
 */
export function appendTaskHistory(
  cwd: string,
  entry: Omit<TaskHistoryEntry, "id" | "timestamp">
): TaskHistoryEntry {
  const full: TaskHistoryEntry = {
    id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    ...entry,
  };

  // --- Write to .agent/tasks/task-history.jsonl ---
  const jsonlPath = resolveTaskHistoryJsonlPath(cwd);
  fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });

  const existing = readTaskHistory(cwd, MAX_ENTRIES);
  const updated = [...existing, full].slice(-MAX_ENTRIES);
  fs.writeFileSync(jsonlPath, updated.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");

  // --- Write to .agent/tasks/task_history.md ---
  const mdPath = resolveTaskHistoryMarkdownPath(cwd);
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });

  const mdEntry = formatMarkdownEntry(full);

  // Atomic read → append → write: basahin ang umiiral na laman, ilagay sa unahan ang bagong entry, isulat pabalik
  let existingRows: string[] = [];
  if (fs.existsSync(mdPath)) {
    const existingMd = fs.readFileSync(mdPath, "utf-8");
    // Kunin ang mga umiiral na table row (mga linyang nagsisimula sa "| " na hindi header o separator)
    existingRows = existingMd.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("|---") && !l.startsWith("| Timestamp"));
  }

  // Ilagay sa unahan ang bagong entry, pagkatapos ay i-cap sa MAX_MARKDOWN_ENTRIES
  const allRows = [mdEntry, ...existingRows].slice(0, MAX_MARKDOWN_ENTRIES);
  const mdContent = MARKDOWN_HEADER + allRows.join("\n") + "\n";

  fs.writeFileSync(mdPath, mdContent, "utf-8");

  return full;
}

/** Ang header na isinusulat sa itaas ng .agent/tasks/task_history.md kapag unang ginawa ang file. */
const MARKDOWN_HEADER = `# Task History

This file records completed top-level tasks. Each entry is a row in the table below.
New entries are prepended on task completion. The file is capped at ${MAX_MARKDOWN_ENTRIES} entries (oldest entries drop off).

| Timestamp | Task | Summary | Iterations | Tokens |
|---|---|---|---|---|
`;

/** I-format ang isang solong entry bilang isang markdown table row. */
function formatMarkdownEntry(entry: TaskHistoryEntry): string {
  const date = new Date(entry.timestamp);
  const localTimestamp = date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });

  // I-escape ang mga pipe character sa task at summary para maiwasang masira ang table
  const escapedTask = (entry.task || "").replace(/\|/g, "\\|");
  const escapedSummary = (entry.summary || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  const tokens = entry.totalTokens != null ? entry.totalTokens.toLocaleString() : "-";

  return `| ${localTimestamp} | ${escapedTask} | ${escapedSummary} | ${entry.iterations} | ${tokens} |`;
}

/** Ang pinakabagong `limit` na task, pinakabago muna. */
export function readTaskHistory(cwd: string, limit = 5): TaskHistoryEntry[] {
  const p = resolveTaskHistoryJsonlPath(cwd);
  if (fs.existsSync(p)) {
    const lines = fs.readFileSync(p, "utf-8").split("\n").filter((l) => l.trim());
    const entries: TaskHistoryEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // laktawan ang sirang linya sa halip na mabigo ang buong pagbasa
      }
    }
    return entries.slice(-limit).reverse();
  }

  // Fallback: read from .agent/tasks/task_history.md
  const mdPath = resolveTaskHistoryMarkdownPath(cwd);
  if (!fs.existsSync(mdPath)) return [];

  const md = fs.readFileSync(mdPath, "utf-8");
  return parseMarkdownEntries(md).slice(0, limit);
}

/** Nagpa-parse ng mga markdown table row pabalik sa mga TaskHistoryEntry object. */
function parseMarkdownEntries(md: string): TaskHistoryEntry[] {
  const entries: TaskHistoryEntry[] = [];
  // Kunin ang mga table row (mga linyang nagsisimula sa "| " na hindi ang header separator)
  const rows = md.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("|---"));
  for (const row of rows) {
    // Hatiin sa "|" at i-trim ang bawat cell
    const cells = row.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
    if (cells.length < 5) continue;

    const timestampStr = cells[0];
    const task = cells[1];
    const summary = cells[2];
    const iterations = parseInt(cells[3], 10) || 0;
    const tokenStr = cells[4];
    const totalTokens = tokenStr && tokenStr !== "-" ? parseInt(tokenStr.replace(/,/g, ""), 10) || undefined : undefined;

    // I-convert pabalik ang local timestamp sa ISO — best effort
    const parsedDate = new Date(timestampStr);
    const timestamp = isNaN(parsedDate.getTime()) ? new Date().toISOString() : parsedDate.toISOString();

    entries.push({
      id: `md_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      task,
      summary,
      timestamp,
      iterations,
      totalTokens,
    });
  }
  return entries;
}

/** Paghahanap ng keyword sa mga task description at summary, pinakabagong tugma muna. */
export function searchTaskHistory(cwd: string, query: string, limit = 5): TaskHistoryEntry[] {
  const all = readTaskHistory(cwd, MAX_ENTRIES);
  const q = query.toLowerCase();
  return all.filter((e) => e.task.toLowerCase().includes(q) || e.summary.toLowerCase().includes(q)).slice(0, limit);
}

