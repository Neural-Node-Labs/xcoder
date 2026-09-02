import { appendTaskHistory, readTaskHistory, TaskHistoryEntry } from "../core/taskHistory.js";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const cwdBase = process.argv[2];
if (!cwdBase) throw new Error("usage: node testTaskHistoryMarkdown.js <workspace-dir>");

let passCount = 0;
function pass(msg: string) {
  passCount += 1;
  console.log(`PASS: ${msg}`);
}

/**
 * Test 1: appendTaskHistory creates .agent/tasks/task_history.md with a header when the file
 * doesn't exist yet. The file should contain the markdown table header and the new entry
 * as a table row.
 */
async function testCreatesFileWithHeader() {
  const cwd = path.join(cwdBase, "t1");
  fs.mkdirSync(cwd, { recursive: true });

  const entry = appendTaskHistory(cwd, {
    task: "implement feature X",
    summary: "Implemented the rate limiter with Redis backend, added tests, verified with load testing.",
    iterations: 15,
    totalTokens: 45000,
  });

  const mdPath = path.join(cwd, ".agent", "tasks", "task_history.md");
  assert.ok(fs.existsSync(mdPath), ".agent/tasks/task_history.md should be created");

  const content = fs.readFileSync(mdPath, "utf-8");

  // Verify header
  assert.ok(content.startsWith("# Task History"), "file should start with # Task History header");
  assert.ok(content.includes("| Timestamp | Task | Summary | Iterations | Tokens |"), "file should contain table header");
  assert.ok(content.includes("|---|---|---|---|---|"), "file should contain table separator");

  // Verify the entry is present as a table row
  assert.ok(content.includes("| "), "file should contain table rows");
  assert.ok(content.includes("implement feature X"), "entry task should be in the file");
  assert.ok(content.includes("15"), "entry iterations should be in the file");
  assert.ok(content.includes("45,000"), "entry tokens should be in the file");

  // Verify the entry has the correct id and timestamp
  assert.ok(entry.id.startsWith("task_"), `entry id should start with "task_", got: ${entry.id}`);
  assert.ok(entry.timestamp, "entry should have a timestamp");

  pass("appendTaskHistory creates .agent/tasks/task_history.md with header and table row");
}

/**
 * Test 2: Multiple entries are prepended (newest first) and the file contains all entries
 * in reverse chronological order.
 */
async function testMultipleEntriesPrepend() {
  const cwd = path.join(cwdBase, "t2");
  fs.mkdirSync(cwd, { recursive: true });

  // First entry
  appendTaskHistory(cwd, {
    task: "first task",
    summary: "First task completed.",
    iterations: 5,
    totalTokens: 1000,
  });

  // Second entry (should appear first in the file)
  appendTaskHistory(cwd, {
    task: "second task",
    summary: "Second task completed.",
    iterations: 10,
    totalTokens: 2000,
  });

  const mdPath = path.join(cwd, ".agent", "tasks", "task_history.md");
  const content = fs.readFileSync(mdPath, "utf-8");
  const rows = content.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("|---") && !l.startsWith("| Timestamp"));

  assert.equal(rows.length, 2, "should have 2 table rows");

  // Second entry should be first (newest first)
  assert.ok(rows[0].includes("second task"), "newest entry should be first");
  assert.ok(rows[1].includes("first task"), "oldest entry should be second");

  pass("multiple entries are prepended with newest first");
}

/**
 * Test 3: The markdown file is capped at MAX_MARKDOWN_ENTRIES (50). When more entries
 * are added, the oldest ones drop off.
 */
async function testCapsAtMaxEntries() {
  const cwd = path.join(cwdBase, "t3");
  fs.mkdirSync(cwd, { recursive: true });

  // Add 55 entries (exceeds the 50 cap)
  for (let i = 0; i < 55; i++) {
    appendTaskHistory(cwd, {
      task: `task ${i}`,
      summary: `Summary for task ${i}.`,
      iterations: i,
      totalTokens: i * 100,
    });
  }

  const mdPath = path.join(cwd, ".agent", "tasks", "task_history.md");
  const content = fs.readFileSync(mdPath, "utf-8");
  const rows = content.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("|---") && !l.startsWith("| Timestamp"));

  assert.equal(rows.length, 50, "should have exactly 50 table rows (capped)");

  // The newest entry should be "task 54" (the last one added)
  assert.ok(rows[0].includes("task 54"), "newest entry should be task 54");
  // The oldest entry should be "task 5" (55 - 50 = 5)
  assert.ok(rows[49].includes("task 5"), "oldest entry should be task 5");

  // "task 0" through "task 4" should have been dropped
  for (let i = 0; i < 5; i++) {
    assert.ok(!content.includes(`task ${i}`), `task ${i} should have been dropped`);
  }

  pass("markdown file is capped at 50 entries, oldest dropped");
}

/**
 * Test 4: Entries with pipe characters in task or summary are properly escaped.
 */
async function testEscapesPipeCharacters() {
  const cwd = path.join(cwdBase, "t4");
  fs.mkdirSync(cwd, { recursive: true });

  appendTaskHistory(cwd, {
    task: "fix | bug in parser",
    summary: "Fixed | the | pipe | issue.",
    iterations: 3,
    totalTokens: 500,
  });

  const mdPath = path.join(cwd, ".agent", "tasks", "task_history.md");
  const content = fs.readFileSync(mdPath, "utf-8");

  // The escaped pipes should be in the content
  assert.ok(content.includes("fix \\| bug in parser"), "pipe in task should be escaped");
  assert.ok(content.includes("Fixed \\| the \\| pipe \\| issue."), "pipes in summary should be escaped");

  pass("pipe characters in task and summary are escaped");
}

/**
 * Test 5: Entries with no totalTokens show "-" in the tokens column.
 */
async function testNoTokensShowsDash() {
  const cwd = path.join(cwdBase, "t5");
  fs.mkdirSync(cwd, { recursive: true });

  appendTaskHistory(cwd, {
    task: "task without tokens",
    summary: "No token tracking.",
    iterations: 2,
    // totalTokens is undefined
  });

  const mdPath = path.join(cwd, ".agent", "tasks", "task_history.md");
  const content = fs.readFileSync(mdPath, "utf-8");

  // Should show "-" for tokens
  assert.ok(content.includes("| - |"), "tokens column should show '-' when totalTokens is undefined");

  pass("entries without totalTokens show '-' in tokens column");
}

/**
 * Test 6: readTaskHistory can parse the markdown file back into TaskHistoryEntry objects
 * (fallback when JSONL file doesn't exist).
 */
async function testReadTaskHistoryFromMarkdown() {
  const cwd = path.join(cwdBase, "t6");
  fs.mkdirSync(cwd, { recursive: true });

  // Write entries via appendTaskHistory
  appendTaskHistory(cwd, {
    task: "readable task",
    summary: "This task should be readable from markdown.",
    iterations: 7,
    totalTokens: 3500,
  });

  // Delete the JSONL file to force fallback to markdown
  const jsonlPath = path.join(cwd, ".agent", "task-history.jsonl");
  if (fs.existsSync(jsonlPath)) {
    fs.unlinkSync(jsonlPath);
  }

  // Read back from markdown
  const entries = readTaskHistory(cwd, 10);

  assert.ok(entries.length >= 1, "should read at least 1 entry from markdown");
  const entry = entries.find((e) => e.task === "readable task");
  assert.ok(entry, "should find the readable task entry");
  assert.equal(entry?.iterations, 7, "iterations should be 7");
  assert.equal(entry?.totalTokens, 3500, "totalTokens should be 3500");
  assert.ok(entry?.summary.includes("readable from markdown"), "summary should match");

  pass("readTaskHistory can parse markdown table rows back into TaskHistoryEntry objects");
}

/**
 * Test 7: The markdown file is atomically written (read → append → write). Verify the
 * file is valid markdown after multiple writes.
 */
async function testAtomicWrite() {
  const cwd = path.join(cwdBase, "t7");
  fs.mkdirSync(cwd, { recursive: true });

  // Write 10 entries
  for (let i = 0; i < 10; i++) {
    appendTaskHistory(cwd, {
      task: `atomic task ${i}`,
      summary: `Atomic write test ${i}.`,
      iterations: i,
      totalTokens: i * 100,
    });
  }

  const mdPath = path.join(cwd, ".agent", "tasks", "task_history.md");
  const content = fs.readFileSync(mdPath, "utf-8");

  // Verify the file is valid: starts with header, has table rows, ends with newline
  assert.ok(content.startsWith("# Task History"), "file should start with header");
  assert.ok(content.endsWith("\n"), "file should end with newline");

  // Count rows
  const rows = content.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("|---") && !l.startsWith("| Timestamp"));
  assert.equal(rows.length, 10, "should have exactly 10 rows");

  // Verify all entries are present
  for (let i = 0; i < 10; i++) {
    assert.ok(content.includes(`atomic task ${i}`), `atomic task ${i} should be present`);
  }

  pass("markdown file is atomically written with valid structure after multiple writes");
}

async function main() {
  await testCreatesFileWithHeader();
  await testMultipleEntriesPrepend();
  await testCapsAtMaxEntries();
  await testEscapesPipeCharacters();
  await testNoTokensShowsDash();
  await testReadTaskHistoryFromMarkdown();
  await testAtomicWrite();
  console.log(`\n${passCount}/7 task-history-markdown tests passed.`);
}

main().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});

