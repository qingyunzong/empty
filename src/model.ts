export type Action = "allow" | "deny";
export type Decision = "allow" | "deny";

export interface Matcher {
  subject: string;
  op: string;
  resource: string;
}

export interface Rule {
  id: string;
  action: Action;
  cost: number;
  match: Matcher;
}

export interface Request {
  subject: string;
  op: string;
  resource: string;
}

export interface Sample {
  id: string;
  expect: Decision;
  request: Request;
}

export interface Problem {
  candidates: Rule[];
  samples: Sample[];
}

export const MAX_CANDIDATES = 18;

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, (ch) =>
    ch === "*" ? "\0" : "\\" + ch,
  );
  return new RegExp("^" + escaped.replace(/\0/g, ".*") + "$");
}

export function matchGlob(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  return globToRegExp(pattern).test(value);
}

export function ruleMatches(rule: Rule, request: Request): boolean {
  return (
    matchGlob(rule.match.subject, request.subject) &&
    matchGlob(rule.match.op, request.op) &&
    matchGlob(rule.match.resource, request.resource)
  );
}

export interface DecisionResult {
  decision: Decision;
  matched: Rule[];
}

export function decide(rules: Rule[], request: Request): DecisionResult {
  const matched = rules.filter((rule) => ruleMatches(rule, request));
  if (matched.some((rule) => rule.action === "deny")) {
    return { decision: "deny", matched };
  }
  if (matched.some((rule) => rule.action === "allow")) {
    return { decision: "allow", matched };
  }
  return { decision: "deny", matched };
}

function isNonNegInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseMatcher(raw: unknown, where: string): Matcher {
  if (raw === undefined) return { subject: "*", op: "*", resource: "*" };
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${where}: match must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of ["subject", "op", "resource"]) {
    const value = obj[key];
    if (value === undefined) {
      out[key] = "*";
    } else if (typeof value === "string") {
      out[key] = value;
    } else {
      throw new Error(`${where}: match.${key} must be a string`);
    }
  }
  return { subject: out.subject, op: out.op, resource: out.resource };
}

function parseRequest(raw: unknown, where: string): Request {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${where}: request must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  for (const key of ["subject", "op", "resource"]) {
    if (typeof obj[key] !== "string") {
      throw new Error(`${where}: request.${key} must be a string`);
    }
  }
  return {
    subject: obj.subject as string,
    op: obj.op as string,
    resource: obj.resource as string,
  };
}

export function parseProblem(raw: unknown): Problem {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("input must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.candidates)) {
    throw new Error("candidates must be an array");
  }
  if (!Array.isArray(obj.samples)) {
    throw new Error("samples must be an array");
  }
  if (obj.candidates.length > MAX_CANDIDATES) {
    throw new Error(
      `at most ${MAX_CANDIDATES} candidates allowed, got ${obj.candidates.length}`,
    );
  }
  const seen = new Set<string>();
  const candidates: Rule[] = obj.candidates.map((rawRule, index) => {
    const where = `candidates[${index}]`;
    if (typeof rawRule !== "object" || rawRule === null) {
      throw new Error(`${where}: must be an object`);
    }
    const r = rawRule as Record<string, unknown>;
    if (typeof r.id !== "string" || r.id.length === 0) {
      throw new Error(`${where}: id must be a non-empty string`);
    }
    if (seen.has(r.id)) {
      throw new Error(`${where}: duplicate id "${r.id}"`);
    }
    seen.add(r.id);
    if (r.action !== "allow" && r.action !== "deny") {
      throw new Error(`${where}: action must be "allow" or "deny"`);
    }
    if (!isNonNegInt(r.cost)) {
      throw new Error(`${where}: cost must be a non-negative integer`);
    }
    return {
      id: r.id,
      action: r.action,
      cost: r.cost,
      match: parseMatcher(r.match, where),
    };
  });
  const sampleIds = new Set<string>();
  const samples: Sample[] = obj.samples.map((rawSample, index) => {
    const where = `samples[${index}]`;
    if (typeof rawSample !== "object" || rawSample === null) {
      throw new Error(`${where}: must be an object`);
    }
    const s = rawSample as Record<string, unknown>;
    if (typeof s.id !== "string" || s.id.length === 0) {
      throw new Error(`${where}: id must be a non-empty string`);
    }
    if (sampleIds.has(s.id)) {
      throw new Error(`${where}: duplicate id "${s.id}"`);
    }
    sampleIds.add(s.id);
    if (s.expect !== "allow" && s.expect !== "deny") {
      throw new Error(`${where}: expect must be "allow" or "deny"`);
    }
    return { id: s.id, expect: s.expect, request: parseRequest(s.request, where) };
  });
  return { candidates, samples };
}
