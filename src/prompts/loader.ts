import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
// The plugin bundle carries the YAML under assets/prompts next to it; dist/ and src/ keep it beside this module.
const PROMPTS_DIR = existsSync(join(__dirname, "assets", "prompts")) ? join(__dirname, "assets", "prompts") : __dirname;

export type PromptTemplate = {
  name: string;
  description: string;
  variables: string[];
  template: string;
};

const cache = new Map<string, PromptTemplate>();

export function loadTemplate(name: string): PromptTemplate {
  if (name.includes("/") || name.includes("..") || name.includes("\0")) {
    throw new Error(`Invalid template name: ${name}`);
  }

  const cached = cache.get(name);
  if (cached) return cached;

  const filePath = join(PROMPTS_DIR, `${name}.yaml`);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    throw new Error(`Prompt template not found: ${name} (looked at ${filePath})`);
  }

  const parsed = yaml.load(raw) as PromptTemplate;
  if (!parsed || typeof parsed.template !== "string") {
    throw new Error(`Invalid prompt template: ${name} — missing 'template' field`);
  }

  cache.set(name, parsed);
  return parsed;
}

export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

export function renderTemplate(name: string, vars: Record<string, string>): string {
  const tpl = loadTemplate(name);
  return interpolate(tpl.template, vars);
}
