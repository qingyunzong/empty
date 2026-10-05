import type { AttributeSpec, Condition, Effect, Policy, Rule, Spec, Value } from "./types.js";

export const MAX_RULES = 20;

export class SpecError extends Error {}

function isValue(x: unknown): x is Value {
  return typeof x === "string" || typeof x === "number" || typeof x === "boolean";
}

function valueKey(v: Value): string {
  return `${typeof v}:${String(v)}`;
}

function fail(message: string): never {
  throw new SpecError(message);
}

function parseAttributes(raw: unknown): AttributeSpec[] {
  if (!Array.isArray(raw)) fail('"attributes" must be an array');
  const seen = new Set<string>();
  return raw.map((entry, i): AttributeSpec => {
    if (typeof entry !== "object" || entry === null) fail(`attributes[${i}] must be an object`);
    const obj = entry as Record<string, unknown>;
    if (typeof obj.name !== "string" || obj.name.length === 0) fail(`attributes[${i}].name must be a non-empty string`);
    if (seen.has(obj.name)) fail(`duplicate attribute name "${obj.name}"`);
    seen.add(obj.name);
    if (!Array.isArray(obj.domain) || obj.domain.length === 0) {
      fail(`attributes[${i}] ("${obj.name}") must have a non-empty "domain" array`);
    }
    const domain = obj.domain as unknown[];
    const seenValues = new Set<string>();
    for (const v of domain) {
      if (!isValue(v)) fail(`domain of "${obj.name}" may only contain strings, numbers or booleans`);
      const key = valueKey(v);
      if (seenValues.has(key)) fail(`domain of "${obj.name}" contains duplicate value ${JSON.stringify(v)}`);
      seenValues.add(key);
    }
    return { name: obj.name, domain: domain as Value[] };
  });
}

function parseEffect(raw: unknown, where: string): Effect {
  if (raw === "permit" || raw === "deny") return raw;
  fail(`${where} must be "permit" or "deny"`);
}

function parseCondition(attr: string, raw: unknown, domain: Value[], where: string): Condition {
  const inDomain = (v: Value) => domain.some((d) => d === v);
  const checkValue = (v: unknown): Value => {
    if (!isValue(v)) fail(`${where}: condition value for "${attr}" must be a string, number or boolean`);
    if (!inDomain(v)) fail(`${where}: value ${JSON.stringify(v)} is not in the domain of "${attr}"`);
    return v;
  };
  if (isValue(raw)) return { kind: "eq", attr, value: checkValue(raw) };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(`${where}: condition for "${attr}" must be a value or an object with "eq" | "ne" | "in"`);
  }
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1) fail(`${where}: condition for "${attr}" must have exactly one operator`);
  const op = keys[0]!;
  if (op === "eq") return { kind: "eq", attr, value: checkValue(obj.eq) };
  if (op === "ne") return { kind: "ne", attr, value: checkValue(obj.ne) };
  if (op === "in") {
    if (!Array.isArray(obj.in) || obj.in.length === 0) fail(`${where}: "in" for "${attr}" needs a non-empty array`);
    return { kind: "in", attr, values: obj.in.map(checkValue) };
  }
  fail(`${where}: unknown operator "${op}" (expected "eq", "ne" or "in")`);
}

function parsePolicy(name: string, raw: unknown, attributes: AttributeSpec[]): Policy {
  if (typeof raw !== "object" || raw === null) fail(`policy "${name}" must be an object`);
  const obj = raw as Record<string, unknown>;
  const defaultEffect = obj.default === undefined ? "deny" : parseEffect(obj.default, `policy "${name}".default`);
  const rawRules = obj.rules === undefined ? [] : obj.rules;
  if (!Array.isArray(rawRules)) fail(`policy "${name}".rules must be an array`);
  const rules = rawRules.map((rawRule, i): Rule => {
    const where = `policy "${name}" rule #${i + 1}`;
    if (typeof rawRule !== "object" || rawRule === null) fail(`${where} must be an object`);
    const rule = rawRule as Record<string, unknown>;
    const effect = parseEffect(rule.effect, `${where}.effect`);
    const conditions: Condition[] = [];
    if (rule.when !== undefined) {
      if (typeof rule.when !== "object" || rule.when === null || Array.isArray(rule.when)) {
        fail(`${where}.when must be an object mapping attribute names to conditions`);
      }
      for (const [attr, cond] of Object.entries(rule.when as Record<string, unknown>)) {
        const spec = attributes.find((a) => a.name === attr);
        if (!spec) fail(`${where}.when references undeclared attribute "${attr}"`);
        conditions.push(parseCondition(attr, cond, spec.domain, where));
      }
    }
    return { conditions, effect };
  });
  return { name, rules, defaultEffect };
}

/** Parse and validate a raw JSON document into a Spec. Throws SpecError on invalid input. */
export function parseSpec(raw: unknown): Spec {
  if (typeof raw !== "object" || raw === null) fail("spec must be a JSON object");
  const obj = raw as Record<string, unknown>;
  const attributes = parseAttributes(obj.attributes);
  if (typeof obj.policies !== "object" || obj.policies === null || Array.isArray(obj.policies)) {
    fail('"policies" must be an object with exactly two entries');
  }
  const policyEntries = Object.entries(obj.policies as Record<string, unknown>);
  if (policyEntries.length !== 2) fail(`"policies" must contain exactly two policies, got ${policyEntries.length}`);
  const policies = policyEntries.map(([name, p]) => parsePolicy(name, p, attributes)) as [Policy, Policy];
  const totalRules = policies[0].rules.length + policies[1].rules.length;
  if (totalRules > MAX_RULES) fail(`too many rules: ${totalRules} (maximum is ${MAX_RULES})`);
  let budget: number | undefined;
  if (obj.budget !== undefined) {
    if (typeof obj.budget !== "number" || !Number.isInteger(obj.budget) || obj.budget < 0) {
      fail('"budget" must be a non-negative integer');
    }
    budget = obj.budget;
  }
  return { attributes, policies, budget };
}
