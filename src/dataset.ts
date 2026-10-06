import { readFileSync, writeFileSync } from "node:fs";
import type { Dataset, Group, Sample } from "./types.js";

export const MAX_GROUPS = 8;

function fail(msg: string): never {
  throw new Error(`dataset: ${msg}`);
}

function checkSample(raw: unknown, where: string): Sample {
  const s = raw as Partial<Sample>;
  if (typeof s?.id !== "string" || s.id.length === 0)
    fail(`${where}: sample id must be a non-empty string`);
  if (typeof s.score !== "number" || !Number.isInteger(s.score))
    fail(`${where}: score of sample "${s.id}" must be an integer`);
  if (s.label !== 0 && s.label !== 1)
    fail(`${where}: label of sample "${s.id}" must be 0 or 1`);
  return { id: s.id, score: s.score, label: s.label };
}

export function validate(raw: unknown): Dataset {
  const d = raw as Partial<Dataset>;
  if (typeof d?.budget !== "number" || !Number.isInteger(d.budget) || d.budget < 0)
    fail("budget must be a non-negative integer");
  if (!Array.isArray(d.groups)) fail("groups must be an array");
  if (d.groups.length > MAX_GROUPS)
    fail(`at most ${MAX_GROUPS} groups allowed, got ${d.groups.length}`);
  const names = new Set<string>();
  const groups: Group[] = d.groups.map((g, gi) => {
    const grp = g as Partial<Group>;
    const where = `group[${gi}]`;
    if (typeof grp?.name !== "string" || grp.name.length === 0)
      fail(`${where}: name must be a non-empty string`);
    if (names.has(grp.name)) fail(`duplicate group name "${grp.name}"`);
    names.add(grp.name);
    if (!Array.isArray(grp.samples)) fail(`${where}: samples must be an array`);
    const ids = new Set<string>();
    const samples = grp.samples.map((s, si) => {
      const sample = checkSample(s, `${where}.samples[${si}]`);
      if (ids.has(sample.id))
        fail(`${where}: duplicate sample id "${sample.id}"`);
      ids.add(sample.id);
      return sample;
    });
    return { name: grp.name, samples };
  });
  const version =
    typeof d.version === "number" && Number.isInteger(d.version) && d.version >= 0
      ? d.version
      : 0;
  return { version, budget: d.budget, groups };
}

export function load(path: string): Dataset {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`cannot read dataset file: ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`invalid JSON in dataset file: ${path}`);
  }
  return validate(raw);
}

export function save(path: string, ds: Dataset): void {
  writeFileSync(path, JSON.stringify(ds, null, 2) + "\n");
}

export function findGroup(ds: Dataset, name: string): Group {
  const g = ds.groups.find((x) => x.name === name);
  if (!g) throw new Error(`group not found: "${name}"`);
  return g;
}

/** Adds a sample and bumps the dataset version. */
export function addSample(
  ds: Dataset,
  groupName: string,
  sample: Sample,
): Dataset {
  const g = findGroup(ds, groupName);
  if (g.samples.some((s) => s.id === sample.id))
    throw new Error(`sample id "${sample.id}" already exists in group "${groupName}"`);
  g.samples.push(sample);
  ds.version += 1;
  return ds;
}

/** Removes a sample and bumps the dataset version. */
export function removeSample(
  ds: Dataset,
  groupName: string,
  id: string,
): Dataset {
  const g = findGroup(ds, groupName);
  const i = g.samples.findIndex((s) => s.id === id);
  if (i < 0) throw new Error(`sample id "${id}" not found in group "${groupName}"`);
  g.samples.splice(i, 1);
  ds.version += 1;
  return ds;
}
