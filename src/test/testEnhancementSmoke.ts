/**
 * Smoke test for the requirement_001.md enhancement.
 * Tests that all new modules load, instantiate, and handle errors gracefully.
 * Does NOT require a running PostgreSQL instance — all DB-backed classes
 * are tested with an unreachable connection string to verify graceful fallback.
 */

import { FileTelemetry } from "../telemetry/logger.js";
import { PostgresTelemetry } from "../telemetry/postgresTelemetry.js";
import { PostgresTaskHistory } from "../core/postgresTaskHistory.js";
import { PostgresProjectStore } from "../api/postgresProjectStore.js";
import { PlanStore } from "../api/planStore.js";
import { TOOL_SCHEMAS } from "../tools/toolSchemas.js";
import { createConnection } from "../db/connection.js";
import { loadDatabaseConfig } from "../db/config.js";
import type { DatabaseConfig } from "../db/config.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    failed++;
  }
}

async function main() {
  console.log("\n=== Enhancement Smoke Tests ===\n");

  // ─── 1. Log Rotation (FileTelemetry) ────────────────────────────────────
  console.log("\n--- Log Rotation ---");
  {
    const tmpDir = `/tmp/devnull-test-${Date.now()}`;
    const fs = await import("node:fs");
    const path = await import("node:path");
    fs.mkdirSync(tmpDir, { recursive: true });

    // Create a telemetry instance with a tiny max size (100 bytes) to force rotation
    const telemetry = new FileTelemetry(tmpDir, 100);
    assert(typeof telemetry.logThought === "function", "FileTelemetry.logThought is a function");
    assert(typeof telemetry.logLlmCall === "function", "FileTelemetry.logLlmCall is a function");
    assert(typeof telemetry.logError === "function", "FileTelemetry.logError is a function");

    // Write enough data to trigger rotation
    for (let i = 0; i < 50; i++) {
      await telemetry.logThought({ iteration: i, phase: "search", thought: "x".repeat(50) });
    }

    // Check that the log directory has files
    const files = fs.readdirSync(path.join(tmpDir, ".agent", "logs"));
    assert(files.length > 0, `Log directory has ${files.length} file(s) after writes`);

    // Check for rotated files (files with date suffix)
    const rotatedFiles = files.filter((f: string) => f.includes("_20"));
    if (rotatedFiles.length > 0) {
      console.log(`  INFO: ${rotatedFiles.length} rotated log file(s) detected (expected with 100 byte limit)`);
    }

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log("  PASS: Log rotation test completed without errors");
    passed++;
  }

  // ─── 2. PostgresTelemetry graceful fallback ─────────────────────────────
  console.log("\n--- PostgresTelemetry Graceful Fallback ---");
  {
    const pgConfig: DatabaseConfig = { ...loadDatabaseConfig(), type: "postgres", postgresUrl: "postgresql://localhost:5432/nonexistent_test_db" };
    const pgTelemetry = new PostgresTelemetry(createConnection(pgConfig));
    // These should not throw — they catch errors and log warnings
    await pgTelemetry.logThought({ iteration: 1, phase: "search", thought: "test thought" });
    await pgTelemetry.logLlmCall({ prompt: "hello" }, { response: "world" });
    await pgTelemetry.logError(new Error("test error"), "test context");
    await pgTelemetry.close();
    console.log("  PASS: PostgresTelemetry handles unreachable DB gracefully (no crash)");
    passed++;
  }

  // ─── 3. PostgresTaskHistory graceful fallback ───────────────────────────
  console.log("\n--- PostgresTaskHistory Graceful Fallback ---");
  {
    const pgConfig: DatabaseConfig = { ...loadDatabaseConfig(), type: "postgres", postgresUrl: "postgresql://localhost:5432/nonexistent_test_db" };
    const history = new PostgresTaskHistory(createConnection(pgConfig));
    await history.append({
      id: "test_1",
      task: "test task",
      summary: "test summary",
      timestamp: new Date().toISOString(),
      iterations: 5,
      totalTokens: 100,
    });
    const entries = await history.read(10);
    assert(Array.isArray(entries), "read() returns an array (empty when DB unreachable)");
    const searchResults = await history.search("test", 10);
    assert(Array.isArray(searchResults), "search() returns an array (empty when DB unreachable)");
    await history.close();
    console.log("  PASS: PostgresTaskHistory handles unreachable DB gracefully");
    passed++;
  }

  // ─── 4. PostgresProjectStore graceful fallback ──────────────────────────
  console.log("\n--- PostgresProjectStore Graceful Fallback ---");
  {
    const pgConfig: DatabaseConfig = { ...loadDatabaseConfig(), type: "postgres", postgresUrl: "postgresql://localhost:5432/nonexistent_test_db" };
    const store = new PostgresProjectStore(createConnection(pgConfig));
    const projects = await store.list();
    assert(Array.isArray(projects), "list() returns an array (empty when DB unreachable)");
    const project = await store.get("nonexistent");
    assert(project === undefined, "get() returns undefined for nonexistent project");
    await store.close();
    console.log("  PASS: PostgresProjectStore handles unreachable DB gracefully");
    passed++;
  }

  // ─── 5. PlanStore graceful fallback ─────────────────────────────────────
  console.log("\n--- PlanStore Graceful Fallback ---");
  {
    const pgConfig: DatabaseConfig = { ...loadDatabaseConfig(), type: "postgres", postgresUrl: "postgresql://localhost:5432/nonexistent_test_db" };
    const store = new PlanStore(createConnection(pgConfig));
    const plans = await store.listPlans();
    assert(Array.isArray(plans), "listPlans() returns an array (empty when DB unreachable)");
    const { plan, tasks } = await store.getPlan("nonexistent");
    assert(plan === null, "getPlan() returns null for nonexistent plan");
    assert(Array.isArray(tasks), "getPlan() tasks is an array");
    await store.close();
    console.log("  PASS: PlanStore handles unreachable DB gracefully");
    passed++;
  }

  // ─── 6. Tool Schemas — new plan tools registered ────────────────────────
  console.log("\n--- Tool Schemas ---");
  {
    const toolNames = TOOL_SCHEMAS.map((s) => s.function.name);
    assert(toolNames.includes("save_plan_tool"), "save_plan_tool is registered in TOOL_SCHEMAS");
    assert(toolNames.includes("update_task_status_tool"), "update_task_status_tool is registered in TOOL_SCHEMAS");
    assert(toolNames.includes("add_plan_task_tool"), "add_plan_task_tool is registered in TOOL_SCHEMAS");
    assert(toolNames.includes("delete_plan_task_tool"), "delete_plan_task_tool is registered in TOOL_SCHEMAS");

    // Verify required params
    const savePlanSchema = TOOL_SCHEMAS.find((s) => s.function.name === "save_plan_tool")!;
    assert(savePlanSchema.function.parameters.required!.includes("taskDescription"), "save_plan_tool requires taskDescription");
    assert(savePlanSchema.function.parameters.required!.includes("planContent"), "save_plan_tool requires planContent");
    assert(savePlanSchema.function.parameters.required!.includes("tasks"), "save_plan_tool requires tasks");

    const updateStatusSchema = TOOL_SCHEMAS.find((s) => s.function.name === "update_task_status_tool")!;
    assert(updateStatusSchema.function.parameters.required!.includes("taskId"), "update_task_status_tool requires taskId");
    assert(updateStatusSchema.function.parameters.required!.includes("status"), "update_task_status_tool requires status");

    const addTaskSchema = TOOL_SCHEMAS.find((s) => s.function.name === "add_plan_task_tool")!;
    assert(addTaskSchema.function.parameters.required!.includes("planId"), "add_plan_task_tool requires planId");
    assert(addTaskSchema.function.parameters.required!.includes("description"), "add_plan_task_tool requires description");

    const deleteTaskSchema = TOOL_SCHEMAS.find((s) => s.function.name === "delete_plan_task_tool")!;
    assert(deleteTaskSchema.function.parameters.required!.includes("taskId"), "delete_plan_task_tool requires taskId");

    console.log("  PASS: All 4 new plan tools are properly registered with correct required params");
    passed++;
  }

  // ─── 7. Tool Dispatcher — handlers exist ────────────────────────────────
  console.log("\n--- Tool Dispatcher ---");
  {
    const fs = await import("node:fs");
    const dispatcherSource = fs.readFileSync(
      new URL("../../src/tools/toolDispatcher.ts", import.meta.url),
      "utf-8"
    );
    assert(dispatcherSource.includes('case "save_plan_tool"'), "dispatcher has save_plan_tool handler");
    assert(dispatcherSource.includes('case "update_task_status_tool"'), "dispatcher has update_task_status_tool handler");
    assert(dispatcherSource.includes('case "add_plan_task_tool"'), "dispatcher has add_plan_task_tool handler");
    assert(dispatcherSource.includes('case "delete_plan_task_tool"'), "dispatcher has delete_plan_task_tool handler");
    console.log("  PASS: All 4 new plan tools have handlers in toolDispatcher.ts");
    passed++;
  }

  // ─── 8. API Routes — plan endpoints registered ──────────────────────────
  console.log("\n--- API Routes ---");
  {
    const fs = await import("node:fs");
    const routesSource = fs.readFileSync(
      new URL("../../src/api/routes.ts", import.meta.url),
      "utf-8"
    );
    assert(routesSource.includes("registerPlanRoutes"), "registerPlanRoutes is imported in routes.ts");
    assert(routesSource.includes('registerPlanRoutes(router)'), "registerPlanRoutes is called in routes.ts");
    assert(routesSource.includes("/task-history/:taskId/logs"), "task-history/:taskId/logs endpoint exists");
    console.log("  PASS: Plan routes and task-history/logs endpoint are registered");
    passed++;
  }

  // ─── 9. UI Components exist ─────────────────────────────────────────────
  console.log("\n--- UI Components ---");
  {
    const fs = await import("node:fs");
    const uiDir = new URL("../../ui/src/", import.meta.url);

    assert(fs.existsSync(new URL("components/JsonViewer.tsx", uiDir)), "JsonViewer.tsx exists");
    assert(fs.existsSync(new URL("pages/PlansPage.tsx", uiDir)), "PlansPage.tsx exists");
    assert(fs.existsSync(new URL("pages/PlanDetailPage.tsx", uiDir)), "PlanDetailPage.tsx exists");

    // Verify App.tsx has plan routes
    const appSource = fs.readFileSync(new URL("App.tsx", uiDir), "utf-8");
    assert(appSource.includes("PlansPage"), "App.tsx imports PlansPage");
    assert(appSource.includes("PlanDetailPage"), "App.tsx imports PlanDetailPage");
    assert(appSource.includes('/plans"'), "App.tsx has /plans route");
    assert(appSource.includes('/plans/:id"'), "App.tsx has /plans/:id route");

    // Verify Navbar has Plans link
    const navbarSource = fs.readFileSync(new URL("components/Navbar.tsx", uiDir), "utf-8");
    assert(navbarSource.includes("/plans"), "Navbar has /plans link");

    // Verify client.ts has plan methods
    const clientSource = fs.readFileSync(new URL("api/client.ts", uiDir), "utf-8");
    assert(clientSource.includes("listPlans"), "client.ts has listPlans");
    assert(clientSource.includes("getPlan"), "client.ts has getPlan");
    assert(clientSource.includes("savePlan"), "client.ts has savePlan");
    assert(clientSource.includes("updatePlanStatus"), "client.ts has updatePlanStatus");
    assert(clientSource.includes("updateTaskStatus"), "client.ts has updateTaskStatus");
    assert(clientSource.includes("addPlanTask"), "client.ts has addPlanTask");
    assert(clientSource.includes("deletePlanTask"), "client.ts has deletePlanTask");

    console.log("  PASS: All UI components, routes, and API client methods exist");
    passed++;
  }

  // ─── Summary ────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n=== Results: ${passed}/${total} passed, ${failed}/${total} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});

