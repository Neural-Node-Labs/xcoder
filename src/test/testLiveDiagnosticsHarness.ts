import { runLiveDiagnostics } from "../core/liveDiagnostics.js";
import { LlmMessage, LlmResponse, ToolCall } from "../core/types.js";
import assert from "node:assert/strict";

function tc(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

const HEALTH_SERVER = `const http = require('http');
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); }
  else { res.writeHead(404); res.end(); }
}).listen(port);
`;

const DOCKERFILE = `FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nEXPOSE 3000\nCMD ["node", "server.js"]\n`;

const TODO_SERVER = `const http = require('http');
const port = process.env.PORT || 3000;
let todos = [];
let nextId = 1;
http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/todos') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const todo = { id: nextId++, text: parsed.text, done: false };
        todos.push(todo);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(todo));
      } catch (e) { res.writeHead(400); res.end(); }
    });
  } else if (req.method === 'GET' && req.url === '/todos') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(todos));
  } else if (req.method === 'POST' && /^\\/todos\\/(\\d+)\\/complete$/.test(req.url)) {
    const id = Number(req.url.match(/^\\/todos\\/(\\d+)\\/complete$/)[1]);
    const todo = todos.find(t => t.id === id);
    if (!todo) { res.writeHead(404); res.end(); return; }
    todo.done = true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(todo));
  } else { res.writeHead(404); res.end(); }
}).listen(port);
`;

const TODO_TEST = `const { spawn } = require('child_process');
const assert = require('assert');
const http = require('http');
const port = 3777;
const child = spawn('node', ['server.js'], { env: { ...process.env, PORT: String(port) } });

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { hostname: 'localhost', port, path, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  await wait(500);
  const add = await request('POST', '/todos', { text: 'buy milk' });
  assert.strictEqual(add.status, 201);
  const list1 = await request('GET', '/todos');
  assert.strictEqual(list1.status, 200);
  assert.strictEqual(list1.body.length, 1);
  const complete = await request('POST', '/todos/' + add.body.id + '/complete', {});
  assert.strictEqual(complete.status, 200);
  assert.strictEqual(complete.body.done, true);
  console.log('all todo API tests passed');
  child.kill();
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  child.kill();
  process.exit(1);
});
`;

/** A well-behaved mock agent: writes real working code and validates it, for every diagnostic scenario. */
class HarnessMock {
  private stepCounters = new Map<string, number>();

  async complete(messages: LlmMessage[]): Promise<LlmResponse> {
    if (messages[0]?.content.includes("independent verification agent")) {
      return this.validator();
    }
    const task = messages[1]?.content ?? "";
    const step = this.stepCounters.get(task) ?? 0;
    this.stepCounters.set(task, step + 1);

    // Diagnostic 1: iteration-stop
    if (task.includes("check.js")) {
      const script: LlmResponse[] = [
        { content: "", toolCalls: [tc("c1", "run_command_tool", { command: "node check.js" })] },
        { content: "task_complete: check.js printed 'ready' as expected.", toolCalls: [] },
      ];
      return script[step] ?? script[script.length - 1];
    }
    // Diagnostic 2: restart-approval (needs 3+ real steps to force the maxIterations=2 ceiling)
    if (task.includes("steps.js")) {
      const script: LlmResponse[] = [
        { content: "", toolCalls: [tc("r1", "read_tool", { filePath: "steps.js" })] },
        { content: "", toolCalls: [tc("c1", "run_command_tool", { command: "node steps.js" })] },
        { content: "", toolCalls: [tc("c2", "run_command_tool", { command: "echo done" })] },
        { content: "task_complete: steps.js printed 1,2,3 and echo printed 'done'.", toolCalls: [] },
      ];
      return script[step] ?? script[script.length - 1];
    }
    // Diagnostic 3: no wasteful duplicates
    if (task.includes("flaky.js")) {
      const script: LlmResponse[] = [
        { content: "", toolCalls: [tc("r1", "read_tool", { filePath: "flaky.js" })] },
        { content: "", toolCalls: [tc("c1", "run_command_tool", { command: "node flaky.js" })] },
        { content: "task_complete: flaky.js prints 4 as expected, no need to check again.", toolCalls: [] },
      ];
      return script[step] ?? script[script.length - 1];
    }
    // Diagnostic 4: tools + skills used (Dockerfile task)
    if (task.includes("Write a Dockerfile for a minimal Node.js app")) {
      const script: LlmResponse[] = [
        { content: "", toolCalls: [tc("w1", "write_edit_tool", { mode: "write", filePath: "Dockerfile", content: DOCKERFILE })] },
        { content: "task_complete: Dockerfile written with FROM, WORKDIR, and CMD instructions.", toolCalls: [] },
      ];
      return script[step] ?? script[script.length - 1];
    }
    // Diagnostic 5: ground-up deployable app
    if (task.includes("Build a minimal, deployable Node.js HTTP server")) {
      const script: LlmResponse[] = [
        { content: "", toolCalls: [tc("w1", "write_edit_tool", { mode: "write", filePath: "server.js", content: HEALTH_SERVER })] },
        { content: "", toolCalls: [tc("w2", "write_edit_tool", { mode: "write", filePath: "Dockerfile", content: DOCKERFILE })] },
        { content: "task_complete: server.js exposes GET /health returning 200/ok, Dockerfile added for deployment.", toolCalls: [] },
      ];
      return script[step] ?? script[script.length - 1];
    }
    // Diagnostic 7: full SDLC (todo API)
    if (task.includes("in-memory 'todo list' HTTP API")) {
      const script: LlmResponse[] = [
        { content: "", toolCalls: [tc("w1", "write_edit_tool", { mode: "write", filePath: "server.js", content: TODO_SERVER })] },
        { content: "", toolCalls: [tc("w2", "write_edit_tool", { mode: "write", filePath: "test.js", content: TODO_TEST })] },
        { content: "", toolCalls: [tc("c1", "run_command_tool", { command: "node test.js" })] },
        { content: "", toolCalls: [tc("w3", "write_edit_tool", { mode: "write", filePath: "Dockerfile", content: DOCKERFILE })] },
        { content: "task_complete: designed, built, tested (all assertions passed), and packaged with a Dockerfile for production.", toolCalls: [] },
      ];
      return script[step] ?? script[script.length - 1];
    }
    // Bug-fixing scenarios (diagnostic #6 reuses defaultScenarios()) -- same fixes as testReactAuditor's GoodAgentMock.
    if (task.includes("buggy.js")) {
      const script: LlmResponse[] = [
        { content: "", toolCalls: [tc("r1", "read_tool", { filePath: "buggy.js" })] },
        { content: "", toolCalls: [tc("w1", "write_edit_tool", { mode: "edit", filePath: "buggy.js", oldStr: "return a + b + 1;", newStr: "return a + b;" })] },
        { content: "", toolCalls: [tc("c1", "run_command_tool", { command: "node buggy.js" })] },
        { content: "task_complete: fixed the off-by-one bug, verified output is 5.", toolCalls: [] },
      ];
      return script[step] ?? script[script.length - 1];
    }
    if (task.includes("main.js")) {
      const script: LlmResponse[] = [
        { content: "", toolCalls: [tc("r1", "read_tool", { filePath: "main.js" })] },
        { content: "", toolCalls: [tc("r2", "read_tool", { filePath: "utils.js" })] },
        { content: "", toolCalls: [tc("w1", "write_edit_tool", { mode: "edit", filePath: "utils.js", oldStr: "acc + n, 1);", newStr: "acc + n, 0);" })] },
        { content: "", toolCalls: [tc("c1", "run_command_tool", { command: "node main.js" })] },
        { content: "task_complete: root cause was in utils.js accumulator; fixed and verified output is 10.", toolCalls: [] },
      ];
      return script[step] ?? script[script.length - 1];
    }
    if (task.includes("calc.js")) {
      const script: LlmResponse[] = [
        { content: "", toolCalls: [tc("r1", "read_tool", { filePath: "calc.js" })] },
        {
          content: "",
          toolCalls: [
            tc("w1", "write_edit_tool", {
              mode: "edit",
              filePath: "calc.js",
              oldStr: "const total = afterDiscount; // BUG: tax is never applied",
              newStr: "const total = afterDiscount * (1 + taxPct / 100);",
            }),
          ],
        },
        { content: "", toolCalls: [tc("c1", "run_command_tool", { command: "node calc.js" })] },
        { content: "task_complete: tax was never applied; fixed and verified output is 97.2.", toolCalls: [] },
      ];
      return script[step] ?? script[script.length - 1];
    }
    if (task.includes("greet.js")) {
      const script: LlmResponse[] = [
        { content: "", toolCalls: [tc("r1", "read_tool", { filePath: "greet.js" })] },
        { content: "", toolCalls: [tc("w1", "write_edit_tool", { mode: "edit", filePath: "greet.js", oldStr: "'Hell ' + name", newStr: "'Hello ' + name" })] },
        { content: "", toolCalls: [tc("c1", "run_command_tool", { command: "node greet.js" })] },
        { content: "task_complete: fixed typo, verified output is 'Hello World'.", toolCalls: [] },
      ];
      return script[step] ?? script[script.length - 1];
    }

    return { content: "(unrecognized task in harness mock -- task text did not match any known branch)", toolCalls: [] };
  }

  private validator(): LlmResponse {
    // Always accept in this harness -- goal-validator skepticism itself is already covered by
    // testGoalValidator.ts; this test is specifically about the 7 live-diagnostics mechanics.
    return { content: JSON.stringify({ valid: true, reason: "harness validator: always accept" }), toolCalls: [] };
  }
}

async function main() {
  console.log("Running full live-diagnostics harness against a scripted (non-live) mock...\n");
  const report = await runLiveDiagnostics(new HarnessMock(), "harness-mock-agent");
  console.log(report.markdown);

  for (const r of report.results) {
    assert.equal(r.passed, true, `Diagnostic ${r.id} should pass with a well-behaved harness mock. Evidence: ${r.evidence.join(" | ")}`);
  }
  console.log(`PASS: all 7/7 diagnostics correctly report success when given a well-behaved agent that does real, verifiable work.`);
}

main().catch((err) => {
  console.error("HARNESS TEST FAILED:", err);
  process.exit(1);
});


