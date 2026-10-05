import type { Instance, InstanceInput, Person } from "./types.js";

export const MAX_PEOPLE = 24;
export const MAX_SKILLS = 12;

function normalizeId(value: unknown, where: string): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${where} must be a string or number`);
  }
  const id = String(value);
  if (id.length === 0) throw new Error(`${where} must not be empty`);
  return id;
}

export function parseInstance(raw: unknown): Instance {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("input must be a JSON object");
  }
  const input = raw as InstanceInput;

  if (!Array.isArray(input.people)) throw new Error('"people" must be an array');
  if (input.people.length > MAX_PEOPLE) {
    throw new Error(`at most ${MAX_PEOPLE} people allowed, got ${input.people.length}`);
  }

  const seenIds = new Set<string>();
  const people: Person[] = input.people.map((p, i) => {
    if (typeof p !== "object" || p === null || Array.isArray(p)) {
      throw new Error(`people[${i}] must be an object`);
    }
    const id = normalizeId(p.id, `people[${i}].id`);
    if (seenIds.has(id)) throw new Error(`duplicate person id: ${id}`);
    seenIds.add(id);
    const rawSkills = p.skills ?? [];
    if (!Array.isArray(rawSkills)) throw new Error(`people[${i}].skills must be an array`);
    const skills = rawSkills.map((s) => {
      if (typeof s !== "string" || s.length === 0) {
        throw new Error(`people[${i}].skills entries must be non-empty strings`);
      }
      return s;
    });
    if (new Set(skills).size !== skills.length) {
      throw new Error(`people[${i}].skills contains duplicates`);
    }
    const cost = p.cost;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
      throw new Error(`people[${i}].cost must be a finite number >= 0`);
    }
    return { id, skills, cost, skillMask: 0 };
  });

  const skillIndex = new Map<string, number>();
  const skillNames: string[] = [];
  const addSkill = (name: string): void => {
    if (!skillIndex.has(name)) {
      skillIndex.set(name, skillNames.length);
      skillNames.push(name);
    }
  };
  for (const p of people) for (const s of p.skills) addSkill(s);

  const minSkills = input.minSkills ?? {};
  if (typeof minSkills !== "object" || minSkills === null || Array.isArray(minSkills)) {
    throw new Error('"minSkills" must be an object mapping skill name to integer >= 0');
  }
  for (const [name, value] of Object.entries(minSkills)) {
    if (name.length === 0) throw new Error("minSkills keys must be non-empty strings");
    if (!Number.isInteger(value) || (value as number) < 0) {
      throw new Error(`minSkills["${name}"] must be an integer >= 0`);
    }
    addSkill(name);
  }
  if (skillNames.length > MAX_SKILLS) {
    throw new Error(`at most ${MAX_SKILLS} distinct skills allowed, got ${skillNames.length}`);
  }

  const minMap = minSkills as Record<string, number>;
  const required = skillNames.map((name) => minMap[name] ?? 0);
  for (const p of people) {
    let mask = 0;
    for (const s of p.skills) mask |= 1 << skillIndex.get(s)!;
    p.skillMask = mask;
  }

  const idToIndex = new Map(people.map((p, i) => [p.id, i]));
  const forbiddenMask = people.map(() => 0);
  const forbiddenPairs: Array<[number, number]> = [];
  const seenPairs = new Set<string>();
  const rawPairs = input.forbiddenPairs ?? [];
  if (!Array.isArray(rawPairs)) throw new Error('"forbiddenPairs" must be an array of [id, id] pairs');
  rawPairs.forEach((pair, i) => {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new Error(`forbiddenPairs[${i}] must be a pair [id, id]`);
    }
    const a = normalizeId(pair[0], `forbiddenPairs[${i}][0]`);
    const b = normalizeId(pair[1], `forbiddenPairs[${i}][1]`);
    if (a === b) throw new Error(`forbiddenPairs[${i}] has identical endpoints: ${a}`);
    const ia = idToIndex.get(a);
    const ib = idToIndex.get(b);
    if (ia === undefined) throw new Error(`forbiddenPairs[${i}] references unknown id: ${a}`);
    if (ib === undefined) throw new Error(`forbiddenPairs[${i}] references unknown id: ${b}`);
    const key = ia < ib ? `${ia},${ib}` : `${ib},${ia}`;
    if (seenPairs.has(key)) throw new Error(`duplicate forbidden pair: ${a} ~ ${b}`);
    seenPairs.add(key);
    forbiddenMask[ia]! |= 1 << ib;
    forbiddenMask[ib]! |= 1 << ia;
    forbiddenPairs.push(ia < ib ? [ia, ib] : [ib, ia]);
  });

  return { people, skills: skillNames, required, forbiddenPairs, forbiddenMask };
}
