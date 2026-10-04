export type Tier = "easy" | "medium" | "hard";

export interface Genome {
  version: string;
  prompts: { planner: string; executor: string; critic: string; reflect: string; synth: string };
  params: {
    maxStepsPerTask: number; maxAttempts: number; maxReplans: number;
    memoryTopK: number; plannerTier: Tier; defaultTier: Tier;
  };
}

export interface Task { id: string; goal: string; deps?: string[]; difficulty?: Tier }

export interface Scenario {
  id: string; suites: string[]; task: string;
  files?: Record<string, string>; setup?: string[]; check: string; oracle: string[];
}

export interface ScenarioResult {
  id: string; pass: boolean; steps: number; seconds: number; tokens: number;
  violations: string[]; status: string; note?: string;
}

export interface SuiteReport {
  genome: string; at: number; results: ScenarioResult[];
  passRate: number; medianSteps: number; meanSeconds: number; violations: number; tokens: number;
}

export interface Gate { name: string; pass: boolean; detail: string }

export interface Evolution {
  id: string; createdAt: number; updatedAt: number;
  status: "proposing" | "testing" | "rejected" | "awaiting_approval" | "promoting" | "promoted" | "rolled_back" | "failed";
  tier: "T0" | "T1"; targetKpi: string; rationale: string;
  baseVersion: string; candidate: any; changes: any;
  baselineScore?: number; candidateScore?: number; gates: Gate[]; note?: string;
}

export interface Kpi {
  name: string; direction: "max" | "min"; target: number; suite: string; current?: number; measuredAt?: number;
}
export interface Goal { id: string; statement: string; constraints: string[]; autonomy: 0 | 1 | 2 | 3; kpis: Kpi[] }
