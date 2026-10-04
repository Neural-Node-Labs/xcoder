import fs from "node:fs";
import path from "node:path";
import { Scenario } from "../src/types";

export function loadScenarios(): Scenario[] {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "evals", "scenarios.json"), "utf8"));
}
