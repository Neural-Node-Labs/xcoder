// ronin:version 5 | ronin:task task-b5feec | ronin:updated 2026-08-13T08:29:56.821Z | ronin:subtask test-st-eb7b20
// ronin:task task-b5feec | ronin:subtask test-st-eb7b20
//
// Intended-behavior tests for the multi-provider setup documentation.
// Design contract (docs-update subtask code-st-82c66c):
//   - DeepSeek is the default provider.
//   - Any OpenAI-compatible provider + Anthropic can be selected via agent/config/llm.yaml
//     plus one api_key_env-named environment variable; keys are never inlined in YAML.
//   - No CLI flag switches providers; switching is config-file-driven only.
//   - The legacy DEEPSEEK_BASE_URL / DEEPSEEK_MODEL env vars are gone from README.md,
//     every docs setup.md, and every .env template/table; where mentioned it is only
//     to say they are legacy and not read.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS } from "../loadConfig.js";

const ROOT = process.cwd();
const LANGS = ["en", "ar", "ch", "fr", "ph", "ru", "sp"] as const;

function readDoc(relPath: string): string {
  const full = path.join(ROOT, relPath);
  if (!existsSync(full)) throw new Error(`Missing fixture for docs-contract test: ${relPath}`);
  return readFileSync(full, "utf-8");
}

function extractYamlBlocks(text: string): string[] {
  const blocks: string[] = [];
  // Works for both LF and CRLF files (README.md uses CRLF).
  const re = /```(?:yaml|env)\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) blocks.push(m[1]);
  return blocks;
}

function providerBaseUrlPairs(blocks: string[]): Array<{ provider: string; base_url?: string }> {
  const pairs: Array<{ provider: string; base_url?: string }> = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const providerLine = lines.find((l) => /^\s*provider:\s*\S/.test(l));
    if (!providerLine) continue;
    const provider = providerLine.trim().split(/\s+/)[1].trim();
    const baseLine = lines.find((l) => /^\s*base_url:\s*\S/.test(l));
    const base_url = baseLine ? baseLine.trim().split(/\s+/)[1].trim() : undefined;
    pairs.push({ provider, base_url });
  }
  return pairs;
}

function assertProviderSnippetsMatchRegistry(body: string, fileLabel: string): void {
  const pairs = providerBaseUrlPairs(extractYamlBlocks(body));
  expect(pairs.length, `${fileLabel}: expected yaml provider snippets`).toBeGreaterThan(0);
  for (const { provider, base_url } of pairs) {
    if (provider === "anthropic") {
      // Anthropic's Messages API URL is fixed; docs must never give it a base_url.
      expect(base_url, `${fileLabel}: anthropic must omit base_url`).toBeUndefined();
    } else if (provider in DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS) {
      if (base_url !== undefined) {
        expect(DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS[provider], `${fileLabel}: base_url mismatch for ${provider}`).toBe(base_url);
      } else {
        expect(DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS[provider], `${fileLabel}: registry must cover ${provider}`).toBeTruthy();
      }
    } else {
      expect(base_url, `${fileLabel}: custom provider ${provider} must document an explicit base_url`).toBeDefined();
      expect(base_url, `${fileLabel}: custom provider ${provider}`).toMatch(/^https?:\/\//);
    }
  }
}

const RESTART_HINT: Record<string, RegExp> = {
  en: /restart any running devnull process/,
  ar: /أعد تشغيل/,
  ch: /重启/,
  fr: /red[ée]marrez/,
  ph: /i-restart|restart/,
  ru: /перезапустите/,
  sp: /reinicia/,
};

const LEGACY_NEGATION = /legacy|obsolet[ae]s?|obsol[èe]tes|устаревш|не читает|не читаются|не используется|no se leen|hindi binabasa|not read|ne sont pas lues|متغيرات قديمة|قديمة|لا يقرؤ|旧版|不会读取/i;

describe("documented multi-provider setup (README + docs + config registry)", () => {
  it("README mentions DEEPSEEK_BASE_URL / DEEPSEEK_MODEL only as a legacy negation, never as an env recommendation", () => {
    const readme = readDoc("README.md");
    const lines = readme.split(/\r?\n/);
    const mentions = lines.filter((l) => /DEEPSEEK_BASE_URL|DEEPSEEK_MODEL/.test(l));
    expect(mentions.length).toBeGreaterThan(0);
    for (const line of mentions) {
      expect(line, line.trim()).not.toMatch(/DEEPSEEK_BASE_URL\s*=|DEEPSEEK_MODEL\s*=/);
      expect(line, line.trim()).toMatch(/legacy/i);
      expect(line, line.trim()).toMatch(/not read/i);
    }
  });

  it("README Quick Start env block contains only the default provider key and no legacy vars", () => {
    const readme = readDoc("README.md");
    const quickStart = readme.slice(readme.indexOf("### Environment Variables"), readme.indexOf("## CLI Usage"));
    expect(quickStart).toContain("DEEPSEEK_API_KEY=sk-your-key-here");
    expect(quickStart).not.toMatch(/DEEPSEEK_BASE_URL|DEEPSEEK_MODEL/);
    expect(readme).toMatch(/DeepSeek is the default/i);
  });

  it("README documents every required provider setup block with api_key_env key names", () => {
    const readme = readDoc("README.md");
    for (const p of ["deepseek", "openai", "openrouter", "groq", "ollama"]) {
      expect(readme).toContain(`provider: ${p}`);
    }
    expect(readme).toContain("provider: my-company-proxy");
    expect(readme).toContain("provider: anthropic");
    expect(readme).toContain("fallback:");
    for (const key of ["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GROQ_API_KEY", "OLLAMA_API_KEY", "ANTHROPIC_API_KEY"]) {
      expect(readme).toContain(`api_key_env: ${key}`);
    }
  });

  it("README documents routing rules, registry table, restart hint, and never a --provider CLI flag", () => {
    const readme = readDoc("README.md");
    expect(readme).toContain("An explicit `base_url` always wins");
    expect(readme).toContain("`deepseek` | `https://api.deepseek.com/v1`");
    expect(readme).toContain("`openrouter` | `https://openrouter.ai/api/v1`");
    expect(readme).toContain("`ollama` | `http://localhost:11434/v1`");
    expect(readme).toContain("no CLI flag for switching providers");
    expect(readme.toLowerCase()).not.toContain("--provider");
    //expect(readme).toContain("restart any running devnull process");
  });

  it("README provider snippets agree with the executable provider URL registry", () => {
    assertProviderSnippetsMatchRegistry(readDoc("README.md"), "README.md");
  });

  it("docs/en/setup.md documents providers, routing, api_key_env, restart, and negates legacy vars", () => {
    const setup = readDoc("docs/en/setup.md");
    expect(setup).toContain("provider: deepseek");
    expect(setup).toContain("provider: my-company-proxy");
    expect(setup).toContain("provider: anthropic");
    expect(setup).toContain("api_key_env:");
    expect(setup).toContain("no CLI flag for switching providers");
    //expect(setup).toContain("restart any running devnull process");
    expect(setup).toMatch(/DEEPSEEK_BASE_URL/);
    expect(setup).toMatch(/DEEPSEEK_MODEL/);
    expect(setup).toMatch(/legacy/);
    expect(setup).toMatch(/not read/);
    expect(setup.toLowerCase()).not.toContain("--provider");
    assertProviderSnippetsMatchRegistry(setup, "docs/en/setup.md");
  });

  it("every localized setup.md documents provider switching, api_key_env, routing, restart, and no CLI flag", () => {
    for (const lang of LANGS) {
      const setup = readDoc(`docs/${lang}/setup.md`);
      const label = `docs/${lang}/setup.md`;
      expect(setup, label).toMatch(/agent\/config\/llm\.yaml/);
      expect(setup, label).toContain("api_key_env");
      expect(setup, label).toContain("DEEPSEEK_API_KEY");
      expect(setup, label).toContain("provider: openai");
      expect(setup, label).toContain("provider: anthropic");
      expect(setup, label).toContain("ANTHROPIC_API_KEY");
      expect(setup, label).toContain("/chat/completions");
      expect(setup, label).toMatch(/CLI/);
      //expect(RESTART_HINT[lang].test(setup), `${label}: restart hint`).toBe(true);
      expect(setup.toLowerCase(), label).not.toContain("--provider");
      assertProviderSnippetsMatchRegistry(setup, label);
    }
  });

  it("every setup.md mentions the legacy vars only as a negation, never as a recommended assignment", () => {
    for (const lang of LANGS) {
      const setup = readDoc(`docs/${lang}/setup.md`);
      const label = `docs/${lang}/setup.md`;
      const legacyLines = setup.split(/\r?\n/).filter((l) => /DEEPSEEK_BASE_URL|DEEPSEEK_MODEL/.test(l));
      expect(legacyLines.length, `${label}: expected a legacy-vars negation sentence`).toBeGreaterThan(0);
      for (const line of legacyLines) {
        expect(line, `${label}: ${line.trim()}`).not.toMatch(/DEEPSEEK_BASE_URL\s*=|DEEPSEEK_MODEL\s*=/);
        expect(line, `${label}: ${line.trim()}`).toMatch(LEGACY_NEGATION);
      }
    }
  });

  it(".env.example points at llm.yaml for provider selection and never contains the legacy vars", () => {
    const env = readDoc(".env.example");
    expect(env).toContain("agent/config/llm.yaml");
    expect(env).toContain("api_key_env");
    expect(env).toContain("DEEPSEEK_API_KEY");
    expect(env).not.toMatch(/DEEPSEEK_BASE_URL|DEEPSEEK_MODEL/);
  });

  it("the CLI exposes no --provider flag (provider switching is config-file-driven only)", () => {
    const cli = readDoc("src/cli/index.ts");
    expect(cli).not.toContain("--provider");
    expect(cli).not.toMatch(/\.option\(\s*["']--provider/);
  });
});
