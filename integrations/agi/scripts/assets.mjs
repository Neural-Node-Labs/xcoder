import { cpSync, mkdirSync } from "node:fs";
mkdirSync("dist/kernel", { recursive: true });
cpSync("kernel/policy.json", "dist/kernel/policy.json");
cpSync("kernel/evals", "dist/kernel/evals", { recursive: true });
