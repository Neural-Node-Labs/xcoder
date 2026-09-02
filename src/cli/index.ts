#!/usr/bin/env node
// ronin:version 4 | ronin:task task-bc7d1e | ronin:updated 2026-08-13T07:33:45.044Z | ronin:subtask code-st-2ad77b
import { Command } from "commander";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadLlmConfig } from "../config/loadConfig.js";
import { resolveReportsDir } from "../config/paths.js";
import { createLlmClient } from "../llm/deepseekClient.js";
import { setVerbose, reportStartupBanner } from "./consoleReporter.js";
import { FileTelemetry } from "../telemetry/logger.js";
import { OrchestratorOptions } from "../core/orchestrator.js";
import { IReactEngine } from "../core/engine/IReactEngine.js";
import { createEngine, listEngines, DEFAULT_ENGINE } from "../core/engine/EngineRegistry.js";
import { CliIO } from "./CliIO.js";
import { SkillRegistry } from "../core/skillRegistry.js";
import { buildIndex } from "../indexing/indexer.js";
import { recordLesson } from "../core/protocol.js";
import { auditReactLoop } from "../core/reactAuditor.js";
import { runLiveDiagnostics } from "../core/liveDiagnostics.js";
import { startApiServer } from "../api/server.js";
import { dockerComposeUp } from "../tools/dockerComposeDeployTool.js";
import { deployWorkspaceViaSsh } from "../tools/dockerDeploySshTool.js";
import { initializeDatabase } from "../db/initialize.js";
import { installProcessCrashHandler } from "../core/processCrashHandler.js";
import { runPurgeCommand, registerPurgeSubcommand } from "./purgeCommand.js";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";

// ─── I-install ang top-level na process crash handler ──────────────────────────────
// Ito ang DAPAT na unang tumakbo — bago ang anumang ibang initialization — para
// mahuli nito ang mga crash mula sa LAHAT ng code path (engine.run(), runPhasePlanning(),
// runSubagent(), chatLoop(), deploy/audit/diagnose paths, atbp.).
//
// Ang handler:
// 1. Nagla-log ng error kasama ang buong stack trace patungo sa stderr
// 2. Bumubuo ng crash report sa reports/crash-<timestamp>.md
// 3. Sinusubukan ang graceful shutdown
// 4. Umaalis nang may code 1 — WALANG restart/retry logic (walang infinite restart loop)
installProcessCrashHandler(process.cwd());

const program = new Command();
program.name("xcoder").description("xcoder — ReAct CLI agent na may hot-pluggable role skills").version("0.1.0");
program.showHelpAfterError();
registerPurgeSubcommand(program);

program
  .argument("[task]", "paglalarawan ng gawain — katumbas ng --task <description>")
  .option("--chat", "pumasok sa interactive chat mode (workspace = kasalukuyang folder)")
  .option("--task <description>", "isagawa ang isang solong gawain, humihingi ng paglilinaw kung kailangan")
  .option("--index", "i-index ang kasalukuyang workspace patungo sa .agent/index/")
  .option("--skills", "ilista ang lahat ng na-load na skill at ang kanilang mga trigger keyword")
  .option("--lesson <text>", "magtala ng aral sa .agent/lessons.md (tingnan ang Self-Improvement Loop sa xcoder.md)")
  .option("--plan", "pilitin ang Plan Mode na naka-on, anuman ang complexity heuristic ng gawain")
  .option("--no-plan", "pilitin ang Plan Mode na naka-off, anuman ang complexity heuristic ng gawain")
  .option("--full-context-token", "panatilihin ang bawat historical na kopya ng read_tool file snapshot sa context sa halip na i-collapse ang mga luma na (tingnan ang src/core/contextCompaction.ts); default: naka-off, naka-on ang lean-token compaction")
  .option("--single-phase", "i-disable ang phase-based na pagpaplano at tumakbo bilang isang solong ReAct loop; default: naka-ON ang phase-planning")
  .option("--auto", "ganap na autonomous mode — awtomatikong sumasagot ng 'yes' sa LAHAT ng interactive prompt (plan approval, phase plan approval, iteration limit continuation, subagent continuation). Pinapatakbo ng LLM ang buong proseso mula simula hanggang tapos nang walang anumang interbensyon ng tao. Gamitin ito para sa CI/CD, awtomatikong testing, o anumang sitwasyon kung saan gusto ng zero na human input.")
  .option("--isolated-workspace", "patakbuhin ang mga tool operation laban sa isang isolated na ./workspace-agent na kopya sa halip na ang live na project file (tingnan ang src/core/workspaceManager.ts); default: naka-off")
  .option("--mock", "patakbuhin gamit ang isang mock na LLM connection sa halip na tunay — walang kailangang API key, walang tunay na network call. Kapaki-pakinabang para sa pag-eksplora ng platform, demo, o mabilisang smoke test. Tingnan ang src/llm/mockClient.ts (AutoMockLlmClient). Katumbas ng XCODER_MOCK_LLM=1 para sa --serve/--ui.")
  .option("--verbose", "i-print ang karagdagang detalye: isang startup banner (engine, provider, model, mock status), at mas mataas na truncation limit sa thought/action/observation console output (tingnan ang src/cli/consoleReporter.ts)")
  .option("--audit-react", "patakbuhin ang built-in na bug-fixing scenario battery sa pamamagitan ng tunay na orchestrator at mag-ulat kung paano ito nagperform")
  .option("--audit-out <path>", "kung saan isusulat ang audit report markdown (default: .agent/reports/react-audit-<timestamp>.md)")
  .option("--diagnose-live", "patakbuhin ang 7-point na ReAct diagnostic suite laban sa tunay na naka-configure na LLM: iteration stopping, restart-approval, pag-iwas sa duplicate-action, paggamit ng tool/skill, ground-up deployable app, bug fixing, at buong SDLC")
  .option("--diagnose-out <path>", "kung saan isusulat ang live diagnostics report markdown (default: .agent/reports/live-diagnostics-<timestamp>.md)")
  .option("--serve", "simulan ang xcoder HTTP API server")
  .option("--ui", "simulan ang parehong xcoder HTTP API server at ang UI frontend")
  .option("--port <number>", "port para sa API server (default: 3001)", parseInt)
  .option("--host <address>", "host para sa API server (default: 0.0.0.0)")
  .option("--deploy", "i-trigger ang deploy mode — pinapatakbo ang docker compose up -d --build")
  .option("--docker", "gamitin ang docker compose para sa deployment (implied ng --deploy)")
  .option("--llm <boolean>", "kung true, ipadala ang deploy task sa LLM bilang devops task; kung false, direktang isagawa (default: false)", (v) => v === "true" || v === "1")
  .option("--remote <ip>", "IP ng remote host na de-deploy-han (gumagamit ng REMOTE_SSH_USER at REMOTE_SSH_PASSWORD mula sa .env)")
  .option("--remote-path <path>", "remote directory path para sa deployment (default: /opt/xcoder)")
  .option("--engine <name>", `orchestration engine na gagamitin (default: "${DEFAULT_ENGINE}"). Mga nakarehistrong engine: ${listEngines().join(", ")}. Tingnan ang src/core/engine/EngineRegistry.ts para magrehistro ng ibang implementation.`, DEFAULT_ENGINE)
  .option("--react", `gamitin ang reference ReAct engine (katumbas ng --engine react)`)
  .option("--lean", "gamitin ang LeanEngine — isang focused, self-contained na ReAct loop na may cancellation, progress observer, at self-healing health scoring (katumbas ng --engine lean)")
  .option("--simple", "gamitin ang SimpleReactEngine — ang plain na ReAct loop na walang Plan Mode, Phase Planning, o goal-validation retry (katumbas ng --engine simple)")
  .option("--swarm", "gamitin ang SwarmEngine — namamahagi ng mga gawain sa parallel na swarm agent na pinapatakbo ng isang orchestrating agent (katumbas ng --engine swarm)")
  .option("--agentic", "gamitin ang AgenticEngine — isang deterministic na agentic ReAct loop na may injectable na ThinkFn (katumbas ng --engine agentic)")
  .option("--brain", "gamitin ang BrainEngine — nagru-route ng isang gawain sa >=2 na role sa pamamagitan ng shared MultiRoleRouter (katumbas ng --engine brain)")
  .option("--procedure", "gamitin ang ProcedureEngine — dalawang-hakbang na procedure generation kasama ang local step execution (katumbas ng --engine procedure)")
  .option("--sdlc", "gamitin ang SdlcEngine — DAG-based na SDLC orchestration: intake classification sa pamamagitan ng rule table, linear na stage pipeline, at isang Validation Gate na independiyenteng sumusuri sa bawat stage bago ito payagang sumulong, may bounded healing at escalation (katumbas ng --engine sdlc; default)")
  .option("--initialize-db", "i-initialize ang PostgreSQL database (gumawa ng mga talahanayan, patakbuhin ang mga migration). Idempotent — ligtas patakbuhin nang paulit-ulit.")
  .option("--purge", "alisin ang agent-internal na metadata at mga likhang artifact (.agent/, kasama ang tasks/, logs/, index/, plans/, reports/ nito) mula sa workspace (tingnan din ang `xcoder purge --help`)")
  .option("--purge-scope <scope>", "saklaw para sa --purge: 'workspace' (default) o 'global' (os.homedir())")
  .option("--purge-targets <list>", "comma-separated na subset ng mga target na pu-purgahin (default: .agent)")
  .option("--purge-dry-run", "kasama ng --purge: i-print kung ano ang aalisin nang hindi tinatanggal ang anuman")
  .option("--purge-force", "kasama ng --purge: alisin ang mga symlink mismo (hindi kailanman ang mga tinutukoy nito)")
  .action(async (taskArg, opts, cmd) => {

    setVerbose(opts.verbose === true);

    const cwd = process.cwd();
    const telemetry = new FileTelemetry(cwd);
    const llmConfig = loadLlmConfig();
    const io = new CliIO({ interactive: !opts.auto });

    // Kapag --mock ang ginamit kasabay ng --serve/--ui, ipasa ang mock mode papunta sa
    // long-running na API server sa pamamagitan ng env var, dahil ang mga request nito ay
    // hindi dumadaan sa parehong per-invocation na `opts` na ito.
    if (opts.mock) process.env.XCODER_MOCK_LLM = "1";

    // ─── I-initialize ang Database ──────────────────────────────────────────
    if (opts.initializeDb) {
      try {
        io.log("[Database] Ini-initialize ang database (paggawa ng mga talahanayan + pagpapatakbo ng mga migration)...");
        const db = await initializeDatabase();
        io.log("[Database] Matagumpay na na-initialize ang database.");
        await db.close();
      } catch (err) {
        io.error(
          `[Database] Nabigo ang initialization: ${err instanceof Error ? err.message : String(err)}`
        );
        process.exit(1);
      }
      return;
    }

    // ─── Purge ─────────────────────────────────────────────────────────────
    // Ang parehong pagbaybay ("xcoder purge" at "xcoder --purge") ay dumadaan sa
    // parehong shared handler para hindi maghiwalay ang legacy flag mula sa subcommand.
    if (opts.purge) {
      const outcome = await runPurgeCommand({
        scope: opts.purgeScope === "global" ? "global" : "workspace",
        targets: opts.purgeTargets ? String(opts.purgeTargets) : undefined,
        dryRun: opts.purgeDryRun === true,
        force: opts.purgeForce === true,
        auto: opts.auto === true,
        cwd: process.cwd(),
      });
      if (outcome.exitCode !== 0) process.exit(outcome.exitCode);
      return;
    }

    // I-merge ang positional [task] sa --task: mananaig ang positional kung parehong ibinigay
    const task = taskArg ?? opts.task;

    // Alamin ang pangalan ng engine: isang dedikadong per-engine flag (--lean, --simple, ...)
    // ay mananaig kaysa sa generic na --engine <name> na opsyon. Kung wala namang ibinigay,
    // ang default ng --engine ("react") ang gagamitin. Pinapanatili nitong maaabot ang bawat
    // rehistradong engine bilang isang first-class, madaling-matuklasang CLI flag habang
    // pinapanatili ang --engine <name> bilang generic na escape hatch para sa mga engine na
    // irerehistro sa hinaharap.
    //
    // Kinukuha ang listahan ng flag mula sa registry (listEngines()) sa halip na i-hardcode,
    // kaya ang pagrehistro ng bagong engine sa EngineRegistry.ts ay awtomatikong ginagawang
    // resolvable ang per-engine flag nito dito — walang paglihis sa pagitan ng registry at
    // ng pagresolba ng CLI flag.
    const engineFlag = listEngines().find((name) => opts[name] === true);
    const engineName = engineFlag ?? opts.engine;

    if (opts.index) {
      const result = await buildIndex(cwd);
      console.log(`Na-index ang ${result.entries.length} na file patungo sa .agent/index/`);
      return;
    }

    if (opts.skills) {
      const registry = new SkillRegistry();
      const headers = registry.loadHeaders();
      for (const h of headers) {
        console.log(`- ${h.name} (${h.role}) — mga trigger: ${h.triggers.join(", ")}`);
      }
      return;
    }

    if (opts.lesson) {
      recordLesson(opts.lesson, cwd);
      console.log(`Naitala ang aral sa .agent/lessons.md`);
      return;
    }

    if (opts.auditReact) {
      const llm = createLlmClient(llmConfig, telemetry, undefined, { mock: opts.mock });
      console.log(`Pinapatakbo ang ReAct bug-fixing audit laban sa ${llmConfig.model}...\n`);
      const report = await auditReactLoop(llm, llmConfig.model);

      const outPath = opts.auditOut ?? path.join(resolveReportsDir(cwd), `react-audit-${Date.now()}.md`);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, report.markdown, "utf-8");

      console.log(report.markdown);
      console.log(`\nNasulat ang buong report sa ${outPath}`);
      console.log(
        `Resulta: ${report.summary.passed}/${report.summary.total} na scenario ang pumasa (independiyenteng na-verify), ` +
          `${report.summary.totalInvariantViolations} invariant violation sa lahat ng scenario.`
      );
      return;
    }

    if (opts.diagnoseLive) {
      const llm = createLlmClient(llmConfig, telemetry, undefined, { mock: opts.mock });
      console.log(`Pinapatakbo ang 7-point na live ReAct diagnostic suite laban sa ${llmConfig.model}...\n`);
      console.log(`Gumagawa ito ng tunay na API call at maaaring tumagal ng ilang minuto (ang diagnostic 7 mag-isa ay maaaring mangailangan ng 15-25 LLM call).\n`);
      const report = await runLiveDiagnostics(llm, llmConfig.model);

      const outPath = opts.diagnoseOut ?? path.join(resolveReportsDir(cwd), `live-diagnostics-${Date.now()}.md`);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, report.markdown, "utf-8");

      console.log(report.markdown);
      console.log(`\nNasulat ang buong report sa ${outPath}`);
      console.log(`Resulta: ${report.summary.passed}/${report.summary.total} na diagnostic ang pumasa.`);
      return;
    }

    if (opts.ui) {
      const port = opts.port || 3001;
      const host = opts.host || "0.0.0.0";

      console.log("🚀 Sinisimulan ang xcoder API server at UI frontend...\n");

      // 1. Simulan ang API server
      startApiServer({ port, host });

      // 2. Alamin ang UI path (ipinapalagay na nasa 'ui' o root ang UI package/folder)
      const uiDir = path.resolve(cwd, "ui"); // ayusin ang path patungo sa kinaroroonan ng xcoder-ui

      if (!fs.existsSync(uiDir)) {
        console.error(`❌ Hindi nahanap ang UI directory sa: ${uiDir}`);
        process.exit(1);
      }

      // 3. I-spawn ang Vite dev server process para sa UI
      const uiProcess = spawn("npm", ["run", "dev"], {
        cwd: uiDir,
        stdio: "inherit",
        shell: true,
      });

      uiProcess.on("error", (err) => {
        console.error("❌ Nabigong simulan ang UI server:", err);
      });

      // I-cleanup ang na-spawn na UI process kapag umalis ang CLI
      process.on("SIGINT", () => {
        uiProcess.kill("SIGINT");
        process.exit(0);
      });

      return;
    }

    if (opts.serve) {
      startApiServer({ port: opts.port, host: opts.host });
      return;
    }

    // ─── Deploy Mode ────────────────────────────────────────────────────────
    // Paggamit:
    //   Lokal:  xcoder --deploy --docker --llm true|false
    //   Remote: xcoder --deploy --docker --remote <ip> [--llm true|false]
    //
    //   --llm true  → ipadala ang deploy task sa LLM bilang devops task (nilulutas ang mga isyu)
    //   --llm false → direktang isagawa ang deploy
    //   --remote <ip> → mag-deploy sa remote host gamit ang REMOTE_SSH_USER at REMOTE_SSH_PASSWORD mula sa .env
    if (opts.deploy || opts.docker) {
      const useLlm = opts.llm === true;
      const remoteHost = opts.remote as string | undefined;

      if (remoteHost) {
        // ── Remote Deploy ────────────────────────────────────────────────
        const remoteUser = (process.env.REMOTE_SSH_USER || "").trim();
        const remotePassword = process.env.REMOTE_SSH_PASSWORD;
        const remotePath = (opts.remotePath as string) || "/opt/xcoder";

        if (!remoteUser || !remotePassword) {
          console.error("❌ Dapat naka-set ang REMOTE_SSH_USER at REMOTE_SSH_PASSWORD sa .env para sa remote deployment.");
          process.exit(1);
        }

        if (useLlm) {
          // Ipadala sa LLM kasama ang remote deploy context
          const llm = createLlmClient(llmConfig, telemetry, undefined, { mock: opts.mock });
          const engine = createEngine(engineName, { llm, telemetry, io, options: { cwd, planMode: "always" } });
          console.log(`🚀 Remote deploy mode: ipinapadala sa LLM bilang devops task (target: ${remoteHost})...\n`);
          await engine.run(
            `Deploy the xcoder stack to remote host ${remoteHost} via SSH. ` +
            `Use the docker_deploy_ssh_tool with host="${remoteHost}", user="${remoteUser}", ` +
            `passwordEnvVar="REMOTE_SSH_PASSWORD", remotePath="${remotePath}". ` +
            `If the build or deployment fails, diagnose and fix any issues. ` +
            `Verify all containers are healthy after deployment. ` +
            `Act as a DevOps engineer — resolve any issues you find.`
          );
        } else {
          // Direktang remote execution — walang kalahok na LLM
          console.log(`🚀 Remote deploy mode: nagde-deploy patungo sa ${remoteHost}...\n`);
          const result = await deployWorkspaceViaSsh({
            host: remoteHost,
            user: remoteUser,
            password: remotePassword,
            remotePath,
          }, cwd);

          if (result.success) {
            console.log(`✅ Matagumpay ang remote deploy patungo sa ${remoteHost}.\n`);
            console.log(`  Mga serbisyo: ${result.services.length} tumatakbo`);
            for (const svc of result.services) {
              console.log(`    - ${svc.name}: ${svc.status} (${svc.health || "walang health check"})`);
            }
          } else {
            console.error(`❌ Nabigo ang remote deploy patungo sa ${remoteHost}.\n`);
            console.error(`  Buod: ${result.summary}`);
            if (result.dockerCommandResult.stderr) {
              console.error(`  Docker stderr: ${result.dockerCommandResult.stderr}`);
            }
            process.exit(1);
          }
        }
      } else if (useLlm) {
        // ── Local Deploy via LLM (Lokal na Deploy sa pamamagitan ng LLM) ──
        const llm = createLlmClient(llmConfig, telemetry, undefined, { mock: opts.mock });
        const engine = createEngine(engineName, { llm, telemetry, io, options: { cwd, planMode: "always" } });
        console.log("🚀 Deploy mode: ipinapadala sa LLM bilang devops task...\n");
        await engine.run(
          "Deploy the xcoder stack using docker compose. " +
          "Run `docker compose up -d --build` in the project root. " +
          "If the build or deployment fails, diagnose and fix any issues. " +
          "Verify all containers are healthy after deployment. " +
          "Act as a DevOps engineer — resolve any issues you find."
        );
      } else {
        // ── Local Direct Deploy (Lokal na Direktang Deploy) ───────────────
        console.log("🚀 Deploy mode: direktang isinasagawa ang docker compose up -d --build...\n");
        const result = await dockerComposeUp(undefined, cwd);
        if (result.exitCode === 0) {
          console.log("✅ Matagumpay ang Docker Compose deployment.\n");
          console.log(result.stdout);
        } else {
          console.error("❌ Nabigo ang Docker Compose deployment.\n");
          console.error(result.stderr);
          process.exit(result.exitCode);
        }
      }
      return;
    }

    const maxIterations = process.env.MAX_ITERATIONS ? parseInt(process.env.MAX_ITERATIONS, 10) : undefined;
    const orchestratorOpts: OrchestratorOptions = { cwd, maxIterations };
    if (opts.plan === true) orchestratorOpts.planMode = "always";
    if (opts.plan === false) orchestratorOpts.planMode = "never";
    if (opts.fullContextToken) orchestratorOpts.fullContextToken = true;
    if (opts.isolatedWorkspace) orchestratorOpts.isolatedWorkspace = true;
    if (opts.singlePhase) orchestratorOpts.singlePhase = true;
    if (opts.auto) orchestratorOpts.auto = true;

    const llm = createLlmClient(llmConfig, telemetry, undefined, { mock: opts.mock });
    const engine = createEngine(engineName, { llm, telemetry, io, options: orchestratorOpts });

    reportStartupBanner({
      engine: engineName,
      provider: opts.mock ? "mock" : llmConfig.provider,
      model: opts.mock ? "(mock)" : llmConfig.model,
      mock: Boolean(opts.mock),
      cwd,
    });

    if (task) {
      await engine.run(task);
      return;
    }

    if (opts.chat) {
      await chatLoop(engine);
      return;
    }

    program.help();
  });

async function chatLoop(engine: IReactEngine): Promise<void> {
  const rl = readline.createInterface({ input, output });
  console.log("xcoder chat mode. I-type ang 'quit', 'exit', o 'bye' para umalis.");

  while (true) {
    const line = await rl.question("\n> ");
    const trimmed = line.trim();
    if (/^(quit|exit|bye)$/i.test(trimmed)) break;
    if (!trimmed) continue;

    await engine.run(trimmed);
  }
  rl.close();
}

program.parseAsync(process.argv).catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});

