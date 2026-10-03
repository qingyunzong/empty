import fs from 'node:fs';
import { ExitError } from './errors.js';
import { buildPlant } from './plant.js';

export function forbiddenKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function loadRecipesFile(path) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ExitError(2, `cannot read recipes file ${path}: ${e.message}`);
  }
  return validateRecipes(raw);
}

// Validates recipes.json content:
//  - plant hierarchy (factory -> workshop -> kettle)
//  - versions with monotonic seq (newer version => larger seq)
//  - forbidden same-kettle pairs; entries may reference named groups via "@name".
//    Group definitions that reference each other cyclically are a "forbidden
//    table cycle" and abort with exit code 18.
export function validateRecipes(raw) {
  const plant = buildPlant(raw.plant ?? { factories: [] });

  const versions = new Map();
  for (const v of raw.versions ?? []) {
    if (!v || typeof v.id !== 'string' || typeof v.seq !== 'number') {
      throw new ExitError(2, 'invalid version entry: need {id, seq}');
    }
    if (versions.has(v.id)) throw new ExitError(2, `duplicate version ${v.id}`);
    versions.set(v.id, { id: v.id, seq: v.seq });
  }

  const groups = raw.forbiddenGroups ?? {};
  const state = new Map(); // name -> 'visiting' | Set<string>
  function expandGroup(name, stack) {
    const s = state.get(name);
    if (s === 'visiting') {
      throw new ExitError(18, `forbidden table cycle: ${[...stack, name].join(' -> ')}`);
    }
    if (s) return s;
    if (!(name in groups)) throw new ExitError(2, `unknown forbidden group @${name}`);
    state.set(name, 'visiting');
    const out = new Set();
    for (const member of groups[name]) {
      if (typeof member === 'string' && member.startsWith('@')) {
        for (const x of expandGroup(member.slice(1), [...stack, name])) out.add(x);
      } else {
        out.add(member);
      }
    }
    state.set(name, out);
    return out;
  }

  const forbidden = new Set();
  const forbiddenList = [];
  const resolve = (x) =>
    typeof x === 'string' && x.startsWith('@') ? [...expandGroup(x.slice(1), [])] : [x];
  for (const entry of raw.forbidden ?? []) {
    if (!entry || !Array.isArray(entry.pair) || entry.pair.length !== 2) {
      throw new ExitError(2, 'invalid forbidden entry: need {pair: [a, b]}');
    }
    for (const a of resolve(entry.pair[0])) {
      for (const b of resolve(entry.pair[1])) {
        if (a === b) throw new ExitError(2, `version ${a} cannot forbid itself`);
        if (!versions.has(a) || !versions.has(b)) {
          throw new ExitError(2, `forbidden pair references unknown version: ${a} / ${b}`);
        }
        const key = forbiddenKey(a, b);
        if (!forbidden.has(key)) {
          forbidden.add(key);
          forbiddenList.push([a, b]);
        }
      }
    }
  }

  return { plant, versions, forbidden, forbiddenList };
}
