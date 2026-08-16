# 🇵🇭 Likha CLI (`likha-cli`)

new repo https://github.com/Neural-Node-Labs/likha-cli rebrand to likha-cli

> **Formerly known as XCoder** — Rebranded to reflect a proud Filipino identity and a mission to empower developers with AI-driven coding assistance.

[![GitHub Repository](https://img.shields.io/badge/GitHub-Neural--Node--Labs%2Flikha--cli-blue?logo=github)](https://github.com/Neural-Node-Labs/likha-cli)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**Likha** *(Filipino for "to create" or "craft")* is a lightweight, AI-powered Command Line Interface (CLI) tool designed to assist developers directly in their terminal. From generating code and automated refactoring to intelligent bug fixes, `likha` acts as your personal AI coding companion.

---

<!-- ronin:version 5 | ronin:task task-b5feec | ronin:updated 2026-08-13T08:18:21.304Z | ronin:subtask code-st-82c66c -->
# likha

**likha** — a ReAct CLI agent with hot-pluggable role skills, DeepSeek by default.

- **Version:** 1.0.0
- **License:** MIT
- **Engine:** TypeScript (Node.js), ReAct loop with multiple engine implementations
- **LLM:** DeepSeek (default), with mock client for testing

---

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [CLI Usage](#cli-usage)
- [Architecture](#architecture)
- [Engines](#engines)
- [Skill System](#skill-system)
- [Plan Mode](#plan-mode)
- [Phase Planning](#phase-planning)
- [Self-Healing & Duplicate Detection](#self-healing--duplicate-detection)
- [Goal Validation](#goal-validation)
- [Context Compaction](#context-compaction)
- [API Server](#api-server)
- [UI](#ui)
- [Deploy Mode](#deploy-mode)
- [Audit & Diagnostics](#audit--diagnostics)
- [Configuration](#configuration)
- [Database Layer](#database-layer)
- [Development](#development)
- [Project Structure](#project-structure)

---

## Overview

likha is a CLI agent that follows the **ReAct** (Reasoning + Acting) pattern: it iteratively thinks about a task, calls tools to gather information or make changes, observes the results, and repeats until the task is complete. It supports multiple orchestration engines, hot-pluggable skill directives, phase planning, an HTTP API server, a React UI, and a built-in self-healing mechanism that detects when the agent is stuck.

### Key Features

- **ReAct loop** with Search → Action → Validation phases
- **Multiple engine implementations** — standard ReAct, LeanEngine, SimpleReactEngine, LangGraph, Swarm, AgenticEngine, BrainEngine, ProcedureEngine
- **Hot-pluggable skill system** — 30+ specialized skills (programmer, architect, devops, tester, etc.) loaded from `agent/skills/`
- **Plan Mode** — generates a task plan before execution, with user approval
- **Phase Planning** — divides complex tasks into sequential phases with isolated context
- **Duplicate action detection** — prevents wasteful repeated tool calls
- **Duplicate iteration reason detection** — three-pass matching (exact, case-insensitive, fuzzy) for repeated reasoning
- **Self-healing health scoring** — detects stalled progress and nudges the agent
- **Goal validation** — independent verification before accepting completion
- **Context compaction** — collapses stale file reads to save tokens (lean-token mode)
- **Subagent delegation** — offloads work to isolated sub-agents
- **Persistent task history** — file-based (`.agent/task-history.jsonl` + `.agent/task_history.md`) and database-backed (SQLite/Postgres)
- **HTTP API server** — Express-based REST API for remote task execution
- **React UI** — Vite + TypeScript frontend for managing tasks, plans, and telemetry
- **Deploy mode** — local Docker Compose or remote SSH deployment
- **ReAct audit** — automated bug-fixing scenario battery
- **Live diagnostics** — 7-point ReAct diagnostic suite

---

## Quick Start

```bash
# Install dependencies
npm run likha:install

# Build
npm run build

# Run a task
npm start -- --task "List all TypeScript files in src/"

# Or use the dev mode (no build needed)
npm run dev -- --task "List all TypeScript files in src/"
```

### Prerequisites

- **Node.js** >= 18
- **DeepSeek API key** — set `DEEPSEEK_API_KEY` in your environment or `.env` file
- **npm** (for UI dependencies)

### Environment Variables

Create a `.env` file in the project root:

```env
DEEPSEEK_API_KEY=sk-your-key-here
# Optional:
# MAX_ITERATIONS=30
# XCODER_API_PORT=3001
# XCODER_API_HOST=0.0.0.0
# DATABASE_URL=postgresql://user:pass@localhost:5432/likha
# REMOTE_SSH_USER=deploy
# REMOTE_SSH_PASSWORD=your-password
# XCODER_SSH_TARGETS=host1:22,host2:22
# XCODER_SSH_USER=fleet-user
# XCODER_SSH_PASSWORD=fleet-password
```

---

## CLI Usage

```bash
likha [task] [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `[task]` | Task description — equivalent to `--task <description>` |

### Options

| Option | Description |
|--------|-------------|
| `--task <description>` | Execute a single task, asking for clarification if needed |
| `--chat` | Enter interactive chat mode (workspace = current folder) |
| `--index` | Index the current workspace into `.agent/index/` |
| `--skills` | List all loaded skills and their trigger keywords |
| `--lesson <text>` | Record a lesson to `tasks/lessons.md` (see likha.md Self-Improvement Loop) |
| `--plan` | Force Plan Mode on, regardless of task complexity heuristic |
| `--no-plan` | Force Plan Mode off, regardless of task complexity heuristic |
| `--full-context-token` | Keep every historical copy of read_tool file snapshots in context instead of collapsing stale ones (see `src/core/contextCompaction.ts`); default: off, lean-token compaction is on |
| `--single-phase` | Disable phase-based planning and run as a single ReAct loop; default: phase-planning is ON |
| `--auto` | Fully autonomous mode — automatically answers 'yes' to ALL interactive prompts (plan approval, phase plan approval, iteration limit continuation, subagent continuation). The LLM drives end-to-end without any human intervention. Use this for CI/CD, automated testing, or any scenario where zero human input is desired. |
| `--isolated-workspace` | Run tool operations against an isolated `./workspace-agent` copy instead of the live project files (see `src/core/workspaceManager.ts`); default: off |
| `--engine <name>` | Orchestration engine to use (default: `react`). Registered engines: `react`, `lean`, `simple`, `swarm`, `langgraph`, `agentic`, `brain`, `procedure`. See `src/core/engine/EngineRegistry.ts` to register another implementation. |
| `--serve` | Start the likha HTTP API server |
| `--ui` | Start both the likha HTTP API server and the UI frontend |
| `--port <number>` | Port for the API server (default: 3001) |
| `--host <address>` | Host for the API server (default: 0.0.0.0) |
| `--deploy` | Trigger deploy mode (Docker Compose) |
| `--docker` | Use Docker Compose for deployment |
| `--llm <boolean>` | Send deploy task to the LLM as a devops task |
| `--remote <ip>` | Remote host IP to deploy to |
| `--remote-path <path>` | Remote directory path for deployment (default: `/opt/likha`) |
| `--audit-react` | Run the built-in bug-fixing scenario battery through the real orchestrator and report on how it performed |
| `--audit-out <path>` | Where to write the audit report markdown (default: `reports/react-audit-<timestamp>.md`) |
| `--diagnose-live` | Run the 7-point ReAct diagnostic suite against the real configured LLM: iteration stopping, restart-approval, duplicate-action avoidance, tool/skill usage, ground-up deployable app, bug fixing, and full SDLC |
| `--diagnose-out <path>` | Where to write the diagnostics report |

### Examples

```bash
# Run a single task
likha "Refactor the authentication module to use JWT tokens"

# Interactive chat mode
likha --chat

# List available skills
likha --skills

# Index the workspace
likha --index

# Record a lesson
likha --lesson "Always validate file paths before writing"

# Use the LangGraph engine
likha --engine langgraph --task "Analyze the test coverage"

# Start the API server
likha --serve --port 3001

# Start the API + UI
likha --ui

# Deploy via Docker Compose
likha --deploy --docker

# Deploy to a remote host
likha --deploy --docker --remote 192.168.1.100

# Run in fully autonomous mode
likha --auto --task "Set up CI/CD pipeline"

# Run the ReAct audit
likha --audit-react

# Run live diagnostics
likha --diagnose-live
```

---

## Architecture

```
likha/
├── agent/                  # Skill definitions and protocol files
│   ├── likha.md           # Engineering protocol (system prompt)
│   └── skills/             # 30+ skill definitions (SKILL.md per skill)
├── src/
│   ├── cli/                # CLI entry point (Commander)
│   │   ├── index.ts        # CLI argument parsing and dispatch
│   │   └── CliIO.ts        # Terminal I/O (spinner, prompts, colors)
│   ├── api/                # Express API server
│   │   ├── server.ts       # Server startup
│   │   ├── routes.ts       # All API endpoints
│   │   ├── auth.ts         # Token-based authentication
│   │   ├── types.ts        # API request/response types
│   │   ├── projectRoutes.ts
│   │   ├── planRoutes.ts
│   │   ├── projectStore.ts
│   │   ├── planStore.ts
│   │   ├── wbsStore.ts
│   │   ├── phaseReportStore.ts
│   │   ├── taskHistoryStore.ts
│   │   └── llmKeyStore.ts
│   ├── core/               # Core orchestration logic
│   │   ├── engine/         # Engine implementations
│   │   │   ├── IReactEngine.ts       # Engine interface + V2 lifecycle
│   │   │   ├── EngineRegistry.ts     # Factory pattern for engine creation
│   │   │   ├── LeanEngine.ts         # Focused ReAct loop
│   │   │   ├── SimpleReactEngine.ts  # Bare ReAct loop (no plan/phase/validation)
│   │   │   ├── LangGraphEngine.ts    # LangGraph StateGraph-based loop
│   │   │   ├── SwarmEngine.ts        # Parallel swarm orchestration
│   │   │   ├── AgenticEngine.ts      # Deterministic agentic ReAct loop
│   │   │   ├── BrainEngine.ts        # MultiRoleRouter-based engine
│   │   │   └── ProcedureEngine.ts    # Two-step procedure generation + execution
│   │   ├── io/             # I/O abstractions
│   │   │   ├── AgentIO.ts  # Abstract I/O interface
│   │   │   └── AutoIO.ts   # Headless-safe I/O (no stdin)
│   │   ├── orchestrator.ts # Full-featured ReAct orchestrator
│   │   ├── types.ts        # Core types (LlmMessage, ReActStep, etc.)
│   │   ├── protocol.ts     # Protocol prompt builder
│   │   ├── skillRegistry.ts # Skill loading and routing
│   │   ├── stepScorer.ts   # Health scoring per step
│   │   ├── duplicateActionDetector.ts # Duplicate tool call detection
│   │   ├── iterationReasonDedup.ts    # Duplicate reasoning detection
│   │   ├── contextCompaction.ts       # Stale file read compaction
│   │   ├── goalValidator.ts           # Independent completion validation
│   │   ├── workspaceManager.ts        # Isolated workspace management
│   │   ├── taskHistory.ts             # File-based task history
│   │   ├── reactAuditor.ts            # Bug-fixing scenario battery
│   │   └── liveDiagnostics.ts         # 7-point diagnostic suite
│   ├── tools/              # Tool implementations (20+ tools)
│   │   ├── toolSchemas.ts  # Tool definitions for LLM function calling
│   │   ├── toolDispatcher.ts # Tool call dispatch
│   │   └── *.ts            # Individual tool implementations
│   ├── llm/                # LLM client integrations
│   │   ├── deepseekClient.ts # DeepSeek API client
│   │   └── mockClient.ts   # Mock client for testing
│   ├── config/             # Configuration loading
│   │   └── loadConfig.ts   # LLM config from env/file
│   ├── db/                 # Database layer
│   │   ├── sqliteClient.ts # SQLite client
│   │   ├── postgresClient.ts # PostgreSQL client
│   │   ├── migrations.ts   # Schema migrations
│   │   └── connection.ts   # Connection management
│   ├── indexing/           # Workspace indexing
│   │   ├── indexer.ts      # File indexer
│   │   └── workspaceInfo.ts # Workspace snapshot
│   ├── remote/             # SSH/SCP remote operations
│   │   ├── sshConnection.ts
│   │   └── scpUpload.ts
│   └── telemetry/          # Logging and telemetry
│       ├── logger.ts       # File-based telemetry
│       └── postgresTelemetry.ts # DB-backed telemetry
├── ui/                     # React frontend (Vite + TypeScript)
│   ├── src/
│   │   ├── pages/          # Page components
│   │   ├── components/     # Shared UI components
│   │   └── App.tsx         # Root app with routing
│   └── package.json
├── tasks/                  # Generated task artifacts
│   ├── todo.md             # Current plan
│   ├── lessons.md          # Captured lessons
│   └── *.md                # Phase reports and WBS files
└── .agent/                 # Agent metadata
    ├── index/              # Workspace index
    └── task-history.*      # Task history files
```

---

## Engines

likha provides eight engine implementations, all interchangeable via the `IReactEngine` interface. Select one with the `--engine` flag or via `EngineRegistry.createEngine()`.

| Engine | Flag | Description |
|--------|------|-------------|
| **ReActOrchestrator** | `react` (default) | Full-featured engine with plan mode, phase planning, subagent delegation, goal validation, and self-healing |
| **LeanEngine** | `lean` | Focused, self-contained ReAct loop — the core loop without plan mode or subagents. Supports V2 lifecycle (cancellation, progress observers, state tracking) |
| **SimpleReactEngine** | `simple` | The bare ReAct loop with the same console output, but no Plan Mode, Phase Planning, or goal-validation retry. Context compaction and truncation guard still apply |
| **LangGraphEngine** | `langgraph` | ReAct loop built on `@langchain/langgraph`'s StateGraph with explicit two-node state machine (agent ↔ tools). Supports V2 lifecycle |
| **SwarmEngine** | `swarm` | Parallel swarm orchestration with WBS decomposition and concurrent agent dispatch. Supports V2 lifecycle |
| **AgenticEngine** | `agentic` | Deterministic agentic ReAct loop with an injectable ThinkFn, driven by a MultiRoleRouter asking for a JSON AgentDecision each iteration |
| **BrainEngine** | `brain` | Routes a task across ≥2 roles (orchestrator + critic) via the shared MultiRoleRouter and synthesizes the final answer |
| **ProcedureEngine** | `procedure` | Two-step procedure generation (plan → strict JSON schema) plus local step execution over the tool dispatcher |

### Engine Registry

Engines are registered via `EngineRegistry.ts` using a factory pattern:

```typescript
import { createEngine, listEngines } from "./core/engine/EngineRegistry.js";

const engine = createEngine("lean", { llm, telemetry, io, options });
console.log(listEngines()); // ["react", "lean", "simple", "swarm", "langgraph", "agentic", "brain", "procedure"]
```

### IReactEngineV2 Lifecycle

The V2 interface adds lifecycle management to engines:

```typescript
interface IReactEngineV2 extends IReactEngine {
  cancel(reason?: string): void;
  onProgress(observer: ProgressObserver): () => void;
  getState(): EngineState; // "idle" | "planning" | "running" | "validating" | "cancelled" | "completed" | "error"
  getLastMessages(): LlmMessage[];
  getWorkspacePath(): string;
  getIterationCount(): number;
}
```

---

## Skill System

likha has a hot-pluggable skill system. Skills are defined as markdown files with YAML frontmatter in `agent/skills/<name>/SKILL.md`. Each skill has:

- **Trigger keywords** — matched against the task description to auto-select relevant skills
- **Role** — the persona the LLM should adopt (e.g., "Software Engineer", "DevOps Engineer")
- **Process/Strategies/Instructions** — injected into the system prompt when the skill is selected
- **`composes_with`** — allows multi-skill composition (e.g., programmer + tester)

### Available Skills (30+)

analyst, architect, aws, azure, conversation, devops, docker, docker-expert, filesystem-management, git-vcs, kafka, kubernetes, kubernetes-expert, openshift, pentester, performance-tester, playwright-ui-tester, programmer, qa-engineer, rca, redhat, rosa, scrum-framework, scrum-master-agent, secops, skill-authoring, software-architect, software-engineer, task-planning, tester, ubuntu, ui-ux-design, workspace-context

### How Skills Are Loaded

1. The `SkillRegistry` scans `agent/skills/` for `SKILL.md` files
2. Each file's YAML frontmatter is parsed for name, role, triggers, and `composes_with`
3. When a task is submitted, the registry matches trigger keywords against the task description
4. Matched skills (and their `composes_with` companions) are injected into the LLM's system prompt

```bash
# List all skills and their triggers
likha --skills
```

---

## Plan Mode

Plan Mode generates a task plan before execution, following the engineering protocol's directive: *"Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)."*

### How It Works

1. **Trigger** — Plan mode activates when:
   - `--plan` flag is set (force on)
   - `planMode: "always"` in options
   - `planMode: "auto"` (default) and 2+ skills are matched (indicating cross-cutting work)
2. **Generation** — The LLM produces a markdown checklist (3-8 steps) without calling any tools
3. **Approval** — The plan is written to `tasks/todo.md` and shown to the user for approval
4. **Execution** — After approval, the ReAct loop executes the plan
5. **Review** — After completion, a review section is appended to `tasks/todo.md`

### Two-Phase API Flow

The API supports a two-phase flow for UI integration:

1. `POST /api/v1/chat/plan` — Generate a plan, returns a `sessionId`
2. `POST /api/v1/chat/execute` — Execute the approved plan by `sessionId`

---

## Phase Planning

Phase Planning divides complex tasks into sequential phases, each running as a sub-orchestrator with isolated ReAct memory. This reduces per-phase token footprint at the cost of losing cross-phase context continuity.

### How It Works

1. **Decomposition** — The LLM divides the task into 2-5 sequential phases, each with its own goal
2. **Approval** — The phase plan is shown to the user for approval
3. **Execution** — Each phase runs sequentially as a sub-orchestrator with isolated ReAct memory
4. **Summarization** — After each phase, the LLM summarizes what was accomplished for the next phase
5. **Reporting** — Per-phase reports are saved to `tasks/[task-name]-phase-[N].md`; a WBS file is written to `tasks/[task-name]-wbs.md`

### Phase Artifacts

- `tasks/[task-name]-wbs.md` — Work Breakdown Structure, updated as phases complete
- `tasks/[task-name]-phase-[N].md` — Per-phase reports with results and stats
- Color-coded CLI output showing per-phase token usage and iteration counts

### Disabling Phase Planning

```bash
# Run as a single ReAct loop (no phase planning)
likha --single-phase --task "Complex task"
```

---

## Self-Healing & Duplicate Detection

likha has a multi-layered self-healing system that detects when the agent is stuck and nudges it back on track.

### Health Scoring

Two parallel health score systems track agent progress:

1. **Step-level health** (`stepScorer.ts`) — A heuristic 0-100 score per tool step, based on:
   - Did the tool call error? (-45 penalty)
   - Is this a duplicate action? (-35 penalty)
   - Is the iteration reason a duplicate? (exact: -25, case-insensitive: -20, fuzzy: -15)
   - Did a write/edit/run_command succeed? (+10 reward)
   - Rolling average over the last 5 steps

2. **Memory health score** (`types.ts`) — A 0.0-1.0 score with history, trend, and `ScoreEntry` array:
   - LLM self-assessment (parses `score: X` from reasoning)
   - Heuristic fallback (increment on success, decrement on error)
   - Trend tracking ("up", "down", "stable")

When the rolling health score drops below 40, a one-time nudge is injected into context asking the model to reconsider its approach.

### Duplicate Action Detection

`duplicateActionDetector.ts` detects when the LLM repeats the exact same tool call (same tool + same arguments) that already produced the same observation. This prevents wasteful loops like re-reading the same file or re-running the same command.

### Duplicate Iteration Reason Detection

`iterationReasonDedup.ts` detects when the LLM produces reasoning that is substantively the same as a previous iteration's reasoning. Uses a three-pass matching strategy:

1. **Exact match** (trimmed string equality) — penalty: -25
2. **Case-insensitive match** — penalty: -20
3. **Fuzzy match** (Levenshtein similarity above 0.85 threshold) — penalty: -15

A rolling window (default: last 5 reasons) prevents flagging legitimately similar reasoning from earlier in a long task. Strings shorter than 20 characters are never fuzzy-matched.

> **⚠️ Status Note:** The `thought` parameter for duplicate iteration reason detection is currently NOT passed by any of the four call sites (orchestrator.ts, LangGraphEngine.ts, LeanEngine.ts, SwarmEngine.ts). The feature is dormant in production — it only runs in unit tests.

---

## Goal Validation

Before accepting a completion, likha runs the result past an independent validator (a second LLM call) that checks whether the claimed completion is actually supported by the recorded observations.

- **Enabled by default** (`validateGoal: true`)
- **Max retries:** 2 (configurable via `maxValidatorRetries`)
- **Rejection feedback:** When the validator rejects a claim, the rejection reason is fed back into context and the agent tries again
- **Exhaustion:** After max retries, the final answer is accepted without verification

---

## Context Compaction

Context compaction (lean-token mode) is **enabled by default**. It collapses stale/superseded `read_tool` observations to save tokens.

### What It Does

- When a file is read or written again, every **strictly earlier** `read_tool` observation for that same path is collapsed to a short placeholder
- The latest snapshot of any given file is always left intact
- This also fixes a correctness issue: without compaction, old stale file snapshots stay in context looking just as authoritative as the current one

### What It Does NOT Touch

- Assistant messages' `tool_calls` and `reasoning_content` — DeepSeek's thinking-mode API requires these to be preserved
- `tool_call_id` linkage — never broken
- Non-read_tool observations

### Disabling Compaction

```bash
# Keep all historical file reads in context
likha --full-context-token --task "My task"
```

---

## API Server

likha includes an Express-based HTTP API server for remote task execution and UI integration.

### Starting the Server

```bash
# Start the API server only
likha --serve --port 3001

# Start both API and UI
likha --ui
```

### Authentication

- **Token-based authentication** — all endpoints except `/health`, `/login`, `/register`, and `/users/count` require a Bearer token
- **First-user registration** — the first user to register becomes admin; subsequent users must be added by an admin
- **Password hashing** — passwords are hashed before storage

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/health` | Health check (no auth) |
| `POST` | `/api/v1/login` | Login (no auth) |
| `POST` | `/api/v1/logout` | Logout (no auth) |
| `POST` | `/api/v1/register` | Register first user only (no auth) |
| `GET` | `/api/v1/users/count` | User count (no auth) |
| `POST` | `/api/v1/chat` | Execute a task |
| `POST` | `/api/v1/chat/plan` | Generate a plan (returns sessionId) |
| `POST` | `/api/v1/chat/execute` | Execute an approved plan by sessionId |
| `GET` | `/api/v1/telemetry` | Read telemetry logs |
| `GET` | `/api/v1/skills` | List all skills |
| `GET` | `/api/v1/users` | List users |
| `POST` | `/api/v1/users` | Create user (admin only) |
| `PUT` | `/api/v1/users/:id` | Update user |
| `DELETE` | `/api/v1/users/:id` | Delete user |
| `GET` | `/api/v1/plans` | List plans |
| `POST` | `/api/v1/plans` | Create plan |
| `GET` | `/api/v1/plans/:id` | Get plan with tasks |
| `PUT` | `/api/v1/plans/:id/status` | Update plan status |
| `PUT` | `/api/v1/plans/:planId/tasks/:taskId` | Update task status within a plan |
| `POST` | `/api/v1/plans/:id/tasks` | Add a task to a plan |
| `DELETE` | `/api/v1/plans/:planId/tasks/:taskId` | Delete a task from a plan |
| `GET` | `/api/v1/task-history` | Read task history |
| `POST` | `/api/v1/task-history` | Add task history entry |
| `GET` | `/api/v1/task-history/:taskId/logs` | Get telemetry logs for a specific task |
| `GET` | `/api/v1/phase-reports` | List phase reports (requires `taskId` query param) |
| `GET` | `/api/v1/phase-reports/:id` | Get phase report by ID |
| `GET` | `/api/v1/wbs` | List WBS entries (requires `taskId` query param) |
| `PUT` | `/api/v1/wbs/:id/status` | Update WBS entry status |
| `GET` | `/api/v1/projects` | List projects |
| `POST` | `/api/v1/projects` | Create a project |
| `PUT` | `/api/v1/projects/:id` | Update a project |
| `POST` | `/api/v1/projects/:id/activate` | Set a project as active |
| `DELETE` | `/api/v1/projects/:id` | Delete a project |
| `GET` | `/api/v1/projects/:id/files` | Browse workspace files (optional `?path=` query) |
| `DELETE` | `/api/v1/projects/:id/files` | Delete a file from the workspace |
| `POST` | `/api/v1/projects/:id/upload` | Upload a file to the workspace (multipart) |
| `GET` | `/api/v1/projects/:id/download` | Download workspace as ZIP archive |
| `GET` | `/api/v1/settings/llm-key` | Check if API key is set |
| `PUT` | `/api/v1/settings/llm-key` | Set API key |
| `DELETE` | `/api/v1/settings/llm-key` | Clear API key |

### Chat API Response

The `/chat` endpoint returns a structured response including:

- `result` — The task result text
- `plan` — The generated plan (if plan mode was active)
- `sessionId` — For two-phase approval flow
- `usage` — Token usage statistics
- `healthScore` — Current self-healing health score
- `limitation` — Explanation if the task didn't complete normally
- `partialSuccess` — Partial progress context when iteration limit was hit
- `subagentContext` — Preserved subagent context for "Continue" button

---

## UI

likha includes a React frontend built with Vite and TypeScript.

### Starting the UI

```bash
# Start both API and UI
likha --ui

# Or use the npm script
npm run likha:ui
```

### UI Features

- **Dashboard** — Overview of recent tasks and system status
- **Chat interface** — Submit tasks and view results
- **Plan management** — View, approve, and track plans
- **Task history** — Browse past task executions
- **Phase reports** — View per-phase results
- **Telemetry viewer** — Browse thinking logs and LLM call logs
- **User management** — Admin panel for user administration
- **Settings** — LLM API key configuration
- **Project management** — Add and switch between projects
- **Diagnostics** — View health scores and system diagnostics

---

## Deploy Mode

likha supports local and remote deployment via Docker Compose.

### Local Deploy

```bash
# Deploy using Docker Compose (direct execution)
likha --deploy --docker

# Deploy with LLM as devops engineer (diagnoses and fixes issues)
likha --deploy --docker --llm true
```

### Remote Deploy

```bash
# Deploy to a remote host
likha --deploy --docker --remote 192.168.1.100

# With custom remote path
likha --deploy --docker --remote 192.168.1.100 --remote-path /opt/myapp

# With LLM assistance
likha --deploy --docker --remote 192.168.1.100 --llm true
```

Requires `REMOTE_SSH_USER` and `REMOTE_SSH_PASSWORD` environment variables for remote deployment.

### Fleet Operations

For fleet operations across multiple hosts, use the shared SSH credentials:

```env
XCODER_SSH_TARGETS=host1:22,host2:22
XCODER_SSH_USER=fleet-user
XCODER_SSH_PASSWORD=fleet-password
```

---

## Audit & Diagnostics

### ReAct Audit

The built-in bug-fixing scenario battery tests the orchestrator against a set of predefined bug-fixing scenarios. Each scenario is independently verified.

```bash
likha --audit-react
likha --audit-out reports/my-audit.md
```

### Live Diagnostics

The 7-point ReAct diagnostic suite tests the real configured LLM against:
1. Iteration stopping
2. Restart-approval
3. Duplicate-action avoidance
4. Tool/skill usage
5. Ground-up deployable app
6. Bug fixing
7. Full SDLC

```bash
likha --diagnose-live
likha --diagnose-out reports/my-diagnostics.md
```

---

## Configuration

### OrchestratorOptions

The `OrchestratorOptions` interface (defined in `src/core/orchestrator.ts`) controls engine behavior:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxIterations` | `number` | `20` | Max ReAct iterations per round |
| `planMode` | `"auto" \| "always" \| "never"` | `"auto"` | Plan mode trigger strategy |
| `validateGoal` | `boolean` | `true` | Independent validation before completion |
| `maxValidatorRetries` | `number` | `2` | Max validator rejection retries |
| `interactive` | `boolean` | `true` | Enable interactive stdin prompts |
| `auto` | `boolean` | `false` | Fully autonomous mode |
| `continueOnLimit` | `boolean` | `false` | Auto-continue past iteration limit |
| `consoleThoughts` | `boolean` | `true` | Show live console output |
| `leanToken` | `boolean` | `true` | Enable context compaction |
| `fullContextToken` | `boolean` | `false` | Disable context compaction |
| `selfHealing` | `boolean` | `true` | Enable self-healing nudges |
| `isolatedWorkspace` | `boolean` | `false` | Run in isolated workspace copy |
| `singlePhase` | `boolean` | `false` | Disable phase planning |
| `io` | `AgentIO` | `AutoIO` | I/O abstraction (CLI vs API) |
| `persistToDb` | `boolean` | `false` | Enable database persistence |

### Environment Variables

```env
DEEPSEEK_API_KEY=sk-your-key-here
# ANTHROPIC_API_KEY=sk-ant-your-key-here   # fallback or provider switch (llm.yaml)
```

| Variable | Description |
|----------|-------------|
| `DEEPSEEK_API_KEY` | DeepSeek API key (default provider — required for default runs) |
| `ANTHROPIC_API_KEY` | Anthropic API key (fallback/provider switch example; `api_key_env` in `llm.yaml` names whatever var any provider needs) |
| `MAX_ITERATIONS` | Override max iterations |
| `XCODER_API_PORT` | API server port |
| `XCODER_API_HOST` | API server host |
| `DATABASE_URL` | PostgreSQL connection string |
| `REMOTE_SSH_USER` | SSH user for remote deploy |
| `REMOTE_SSH_PASSWORD` | SSH password for remote deploy |
| `XCODER_SSH_TARGETS` | Fleet SSH targets |
| `XCODER_SSH_USER` | Fleet SSH user |
| `XCODER_SSH_PASSWORD` | Fleet SSH password |
| `GITHUB_TOKEN` | GitHub token for git operations |

> The legacy `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` env vars are **not read** by likha.
> Provider, base URL, endpoint, and model are configured in `agent/config/llm.yaml` — see below.

### LLM Providers

likha's LLM backend is config-driven and provider-agnostic. **DeepSeek is the default**,
but any OpenAI-compatible provider (OpenAI, OpenRouter, Groq, Ollama, a company proxy, …)
and Anthropic can be selected by editing `agent/config/llm.yaml` and setting the matching
API key environment variable — **no code changes or CLI flags needed**.

**DeepSeek (default):**

```yaml
provider: deepseek
base_url: https://api.deepseek.com/v1
endpoint: /chat/completions
model: deepseek-v4-pro
api_key_env: DEEPSEEK_API_KEY
```

```env
DEEPSEEK_API_KEY=sk-your-key-here
```

**OpenAI:**

```yaml
provider: openai
base_url: https://api.openai.com/v1
endpoint: /chat/completions
model: gpt-5
api_key_env: OPENAI_API_KEY
```

```env
OPENAI_API_KEY=sk-...
```

**OpenRouter:**

```yaml
provider: openrouter
model: anthropic/claude-sonnet-4
api_key_env: OPENROUTER_API_KEY
```

```env
OPENROUTER_API_KEY=sk-...
```

**Groq:**

```yaml
provider: groq
model: llama-3.3-70b-versatile
api_key_env: GROQ_API_KEY
```

```env
GROQ_API_KEY=sk-...
```

**Ollama (local):**

```yaml
provider: ollama
model: llama3.1
api_key_env: OLLAMA_API_KEY  # optional for local; set any name you like, or rely on the registry URL
```

```env
OLLAMA_API_KEY=sk-...
```

**Custom OpenAI-compatible provider (explicit `base_url`/`endpoint`):**

```yaml
provider: my-company-proxy
base_url: https://llm.gateway.example.com/v1
endpoint: /chat/completions
model: custom-model-1
api_key_env: MY_PROXY_API_KEY
```

```env
MY_PROXY_API_KEY=sk-...
```

Known providers with built-in URL registrations (explicit `base_url` always wins):

| Provider | Default base URL |
|---|---|
| `deepseek` | `https://api.deepseek.com/v1` |
| `openai` | `https://api.openai.com/v1` |
| `openrouter` | `https://openrouter.ai/api/v1` |
| `groq` | `https://api.groq.com/openai/v1` |
| `ollama` | `http://localhost:11434/v1` |

**Anthropic:**

```yaml
provider: anthropic
model: claude-sonnet-4-5
api_key_env: ANTHROPIC_API_KEY
```

```env
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

> Anthropic ignores `base_url` and `endpoint` — its Messages API URL is fixed in the client.

**Fallback block (optional; same routing rules as the main block):**

```yaml
fallback:
  provider: deepseek
  base_url: https://api.deepseek.com/v1
  model: deepseek-v4-flash
  api_key_env: DEEPSEEK_API_KEY
```

**Routing rules:**

1. An explicit `base_url` always wins over the built-in provider URL registry.
2. When `base_url` is omitted, the registry entry for `deepseek`/`openai`/`openrouter`/`groq`/`ollama` is used.
3. `endpoint` defaults to `/chat/completions` when omitted.
4. There is **no CLI flag for switching providers** — provider switching is config-file-driven (`agent/config/llm.yaml`) only.

After editing `agent/config/llm.yaml`, restart any running likha process so the new provider is loaded.

---

## Database Layer

likha supports both SQLite and PostgreSQL for persistent storage.

### SQLite

- Default database for local development
- File-based, no server required
- Used when no `DATABASE_URL` is set

### PostgreSQL

- Production database for the API server
- Configured via `DATABASE_URL` environment variable
- Supports migrations, task history, phase reports, WBS, and telemetry

### Initialization

```bash
# Initialize the database (creates tables)
npm run init-db
```

### Database Stores

| Store | Description |
|-------|-------------|
| `TaskHistoryStore` | Task execution history |
| `PhaseReportStore` | Per-phase reports |
| `WbsStore` | Work Breakdown Structure entries |
| `PlanStore` | Saved plans |
| `ProjectStore` | Project configurations |

---

## Development

### Setup

```bash
# Full setup (interactive)
npm run setup

# Non-interactive setup
npm run setup:non-interactive
```

### Scripts

| Script | Description |
|--------|-------------|
| `npm run build` | Compile TypeScript and copy agent files |
| `npm run dev` | Run in dev mode (ts-node) |
| `npm test` | Run test suite (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run likha:link` | Link likha globally via npm link |
| `npm run likha:unlink` | Unlink global likha |
| `npm run likha:install` | Install all dependencies (including UI) |
| `npm run likha:build` | Build both CLI and UI |
| `npm run likha:ui` | Start API + UI concurrently |
| `npm run likha:api` | Start API server only |
| `npm run package:build` | Build distributable package |
| `npm run package:validate` | Validate package |
| `npm run package:tarball` | Create tarball |
| `npm run package:docker` | Build Docker image |
| `npm run package:all` | Build all package formats |
| `npm run init-db` | Initialize database tables |

### Testing

```bash
# Run all tests
npm test

# Run specific test file
npx vitest run src/core/__tests__/iterationReasonDedup.test.ts

# Run tests in watch mode
npm run test:watch
```

### Adding a New Skill

1. Create a directory: `agent/skills/<name>/`
2. Create `SKILL.md` with YAML frontmatter:

```markdown
---
name: my-skill
role: My Role
description: What this skill does
triggers:
  - keyword1
  - keyword2
version: "1.0"
requires_tools: []
composes_with: []
---

## Role
Description of the role.

## Process
Step-by-step process.

## Strategies
Strategies and approaches.

## Instructions
Specific instructions.
```

3. Run `likha --skills` to verify it's loaded

### Adding a New Engine

1. Implement the `IReactEngine` interface (and optionally `IReactEngineV2`)
2. Register it in `src/core/engine/EngineRegistry.ts`:

```typescript
registerEngine("my-engine", ({ llm, telemetry, io, options }) => {
  return new MyEngine(llm, telemetry, myOpts);
});
```

3. Use it: `likha --engine my-engine --task "..."`

---

## Project Structure



```
src/
  core/          ReAct engine, engine/IO abstractions, scoring, skill registry, protocol/plan mode
  cli/           CLI entrypoint, CliIO (terminal presentation)
  api/           Express server, routes, DB-backed stores (task history / phase reports / WBS)
  db/            Database connection, migrations, init
  tools/         Tool schemas + dispatcher
  llm/           LLM client(s) — DeepSeek primary, Anthropic fallback
  telemetry/     FileTelemetry (always-on) + Postgres telemetry (API-only)
  config/        Env/config loading
  indexing/      Workspace indexing for .agent/index/
  remote/        Remote SSH deploy support
agent/
  skills/        SKILL.md files — see Skill System
  config/        LLM provider config (llm.yaml)
ui/
  src/           React app (pages, components/ui primitives, context, API client)
tasks/           Runtime output: todo.md, wbs.md, lessons.md, phase reports (git-ignored in practice)
.log/            Runtime output: FileTelemetry logs (git-ignored in practice)
```
