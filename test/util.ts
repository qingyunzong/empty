import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mapping } from "../src/model.js";
import { createPlan } from "../src/commands.js";
import type { Journal } from "../src/model.js";

export function setupDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "photo-test-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

export function names(dir: string): string[] {
  return readdirSync(dir)
    .filter((n) => !n.startsWith(".photo-organize"))
    .sort();
}

export function contents(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names(dir)) {
    out[name] = readFileSync(join(dir, name), "utf8");
  }
  return out;
}

export function plan(dir: string, mapping: Mapping): Journal {
  const file = join(mkdtempSync(join(tmpdir(), "photo-mapping-")), "mapping.json");
  writeFileSync(file, JSON.stringify(mapping));
  return createPlan(dir, file);
}

export function makeSubdir(dir: string, sub: string): string {
  const path = join(dir, sub);
  mkdirSync(path, { recursive: true });
  return path;
}
