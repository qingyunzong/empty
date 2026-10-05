export const MAX_PEOPLE = 24;
export const MAX_SKILLS = 12;

export interface PersonInput {
  id: string | number;
  skills?: string[];
  cost?: number;
}

export interface ProblemInput {
  people: PersonInput[];
  forbiddenPairs?: Array<[string | number, string | number]>;
  required?: Record<string, number>;
}

export interface Problem {
  /** Normalized string ids, in input order. */
  ids: string[];
  /** Skill universe (first-appearance order: people, then required). */
  skills: string[];
  costs: number[];
  /** personSkillMask[i]: bitmask over skills for person i. */
  personSkillMask: number[];
  /** forbiddenMask[i]: bitmask over people conflicting with person i. */
  forbiddenMask: number[];
  /** Normalized forbidden pairs as string id tuples, deduplicated. */
  forbiddenPairs: Array<[string, string]>;
  /** required[t]: minimum headcount for skill t. */
  required: number[];
}

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeId(raw: unknown, where: string): string {
  if (typeof raw !== "string" && typeof raw !== "number") {
    throw new InputError(`${where}: id must be a string or number`);
  }
  const id = String(raw);
  if (id.length === 0) {
    throw new InputError(`${where}: id must not be empty`);
  }
  return id;
}

export function parseProblem(raw: unknown): Problem {
  if (!isRecord(raw)) {
    throw new InputError("input must be a JSON object");
  }
  if (!Array.isArray(raw.people)) {
    throw new InputError('"people" must be an array');
  }
  const people = raw.people as unknown[];
  if (people.length > MAX_PEOPLE) {
    throw new InputError(`too many people: ${people.length} (max ${MAX_PEOPLE})`);
  }

  const ids: string[] = [];
  const costs: number[] = [];
  const rawSkills: string[][] = [];
  const seenIds = new Set<string>();
  const skillOrder: string[] = [];
  const skillIndex = new Map<string, number>();
  const ensureSkill = (name: string): number => {
    let idx = skillIndex.get(name);
    if (idx === undefined) {
      idx = skillOrder.length;
      skillOrder.push(name);
      skillIndex.set(name, idx);
    }
    return idx;
  };

  people.forEach((entry, i) => {
    const where = `people[${i}]`;
    if (!isRecord(entry)) {
      throw new InputError(`${where}: must be an object`);
    }
    const id = normalizeId(entry.id, `${where}.id`);
    if (seenIds.has(id)) {
      throw new InputError(`${where}: duplicate id "${id}"`);
    }
    seenIds.add(id);
    ids.push(id);

    const cost = entry.cost === undefined ? 0 : entry.cost;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
      throw new InputError(`${where}.cost: must be a finite number >= 0`);
    }
    costs.push(cost);

    const skillsRaw = entry.skills === undefined ? [] : entry.skills;
    if (!Array.isArray(skillsRaw)) {
      throw new InputError(`${where}.skills: must be an array of strings`);
    }
    const personSkills: string[] = [];
    for (const s of skillsRaw) {
      if (typeof s !== "string" || s.length === 0) {
        throw new InputError(`${where}.skills: entries must be non-empty strings`);
      }
      if (!personSkills.includes(s)) {
        personSkills.push(s);
        ensureSkill(s);
      }
    }
    rawSkills.push(personSkills);
  });

  const requiredRaw = raw.required === undefined ? {} : raw.required;
  if (!isRecord(requiredRaw)) {
    throw new InputError('"required" must be an object mapping skill -> minimum count');
  }
  const requiredByName = new Map<string, number>();
  for (const [skill, value] of Object.entries(requiredRaw)) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new InputError(`required["${skill}"]: must be an integer >= 0`);
    }
    requiredByName.set(skill, value);
    ensureSkill(skill);
  }

  if (skillOrder.length > MAX_SKILLS) {
    throw new InputError(`too many skills: ${skillOrder.length} (max ${MAX_SKILLS})`);
  }

  const personSkillMask = rawSkills.map((list) => {
    let mask = 0;
    for (const s of list) {
      mask |= 1 << (skillIndex.get(s) as number);
    }
    return mask;
  });

  const pairsRaw = raw.forbiddenPairs === undefined ? [] : raw.forbiddenPairs;
  if (!Array.isArray(pairsRaw)) {
    throw new InputError('"forbiddenPairs" must be an array of [id, id] pairs');
  }
  const forbiddenMask = new Array<number>(ids.length).fill(0);
  const forbiddenPairs: Array<[string, string]> = [];
  const seenPairs = new Set<string>();
  pairsRaw.forEach((entry, i) => {
    const where = `forbiddenPairs[${i}]`;
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new InputError(`${where}: must be a [id, id] pair`);
    }
    const a = normalizeId(entry[0], `${where}[0]`);
    const b = normalizeId(entry[1], `${where}[1]`);
    if (a === b) {
      throw new InputError(`${where}: a person cannot conflict with themselves ("${a}")`);
    }
    const ia = ids.indexOf(a);
    const ib = ids.indexOf(b);
    if (ia === -1) throw new InputError(`${where}: unknown id "${a}"`);
    if (ib === -1) throw new InputError(`${where}: unknown id "${b}"`);
    const key = a < b ? `${a}${b}` : `${b}${a}`;
    if (seenPairs.has(key)) {
      return;
    }
    seenPairs.add(key);
    forbiddenMask[ia] |= 1 << ib;
    forbiddenMask[ib] |= 1 << ia;
    forbiddenPairs.push([a, b]);
  });

  const required = skillOrder.map((name) => requiredByName.get(name) ?? 0);

  return { ids, skills: skillOrder, costs, personSkillMask, forbiddenMask, forbiddenPairs, required };
}
