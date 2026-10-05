export const MAX_RULES = 20;
export const DEFAULT_BUDGET = 1_000_000;

export interface SpecInput {
  attributes: Record<string, string[]>;
  policies: Record<string, { default: string; rules: { when: Record<string, string>; decision: string }[] }>;
  budget?: number;
}

export interface Rule {
  when: [number, number][];
  decision: string;
}

export interface Policy {
  defaultDecision: string;
  rules: Rule[];
}

export interface Spec {
  attributeNames: string[];
  domains: string[][];
  policyNames: [string, string];
  policies: [Policy, Policy];
  budget: number;
}

interface RawCondition {
  attr: string;
  value: string;
}

interface RawRule {
  conditions: RawCondition[];
  decision: string;
}

interface RawPolicy {
  defaultDecision: string;
  rules: RawRule[];
}

function fail(message: string): never {
  throw new Error(`输入无效: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRawPolicy(
  name: string,
  raw: unknown,
  attrNames: Set<string>,
  domainValues: Map<string, Set<string>>
): RawPolicy {
  if (!isPlainObject(raw)) fail(`策略 "${name}" 必须是对象`);
  const defaultDecision = raw.default;
  if (typeof defaultDecision !== "string" || defaultDecision.length === 0) {
    fail(`策略 "${name}" 缺少非空的 default 决议`);
  }
  const rawRules = raw.rules;
  if (!Array.isArray(rawRules)) fail(`策略 "${name}" 的 rules 必须是数组`);
  if (rawRules.length > MAX_RULES) {
    fail(`策略 "${name}" 含 ${rawRules.length} 条规则，超过上限 ${MAX_RULES}`);
  }
  const rules: RawRule[] = rawRules.map((rawRule, index) => {
    const label = `策略 "${name}" 第 ${index + 1} 条规则`;
    if (!isPlainObject(rawRule)) fail(`${label} 必须是对象`);
    const when = rawRule.when;
    if (!isPlainObject(when)) fail(`${label} 的 when 必须是对象`);
    const decision = rawRule.decision;
    if (typeof decision !== "string" || decision.length === 0) fail(`${label} 缺少非空的 decision`);
    const conditions: RawCondition[] = [];
    for (const [attr, value] of Object.entries(when)) {
      if (!attrNames.has(attr)) fail(`${label} 引用了未知属性 "${attr}"`);
      if (typeof value !== "string") fail(`${label} 中属性 "${attr}" 的条件值必须是字符串`);
      if (!domainValues.get(attr)!.has(value)) fail(`${label} 中属性 "${attr}" 的取值 "${value}" 不在其域内`);
      conditions.push({ attr, value });
    }
    return { conditions, decision };
  });
  return { defaultDecision, rules };
}

export function parseSpec(raw: unknown): Spec {
  if (!isPlainObject(raw)) fail("顶层必须是 JSON 对象");
  const rawAttributes = raw.attributes;
  if (!isPlainObject(rawAttributes)) fail("缺少 attributes 对象");
  const attributeNames = Object.keys(rawAttributes).sort();
  if (attributeNames.length === 0) fail("attributes 至少包含一个属性");
  if (attributeNames.length > 64) fail("属性个数超过上限 64");
  const domains: string[][] = [];
  const domainValues = new Map<string, Set<string>>();
  for (const name of attributeNames) {
    const values = rawAttributes[name];
    if (!Array.isArray(values) || values.length === 0) fail(`属性 "${name}" 的域必须是非空数组`);
    const seen = new Set<string>();
    for (const value of values) {
      if (typeof value !== "string" || value.length === 0) fail(`属性 "${name}" 的域值必须是非空字符串`);
      if (seen.has(value)) fail(`属性 "${name}" 的域值 "${value}" 重复`);
      seen.add(value);
    }
    domains.push(values.slice());
    domainValues.set(name, seen);
  }
  const rawPolicies = raw.policies;
  if (!isPlainObject(rawPolicies)) fail("缺少 policies 对象");
  const policyNames = Object.keys(rawPolicies).sort();
  if (policyNames.length !== 2) fail(`policies 必须恰好包含两个策略，当前为 ${policyNames.length} 个`);
  const attrNameSet = new Set(attributeNames);
  const rawPolicyList = policyNames.map((name) => parseRawPolicy(name, rawPolicies[name], attrNameSet, domainValues));
  const attrIndex = new Map(attributeNames.map((name, index) => [name, index]));
  const valueIndex = attributeNames.map(
    (name, index) => new Map(domains[index]!.map((value, order) => [value, order]))
  );
  const policies: Policy[] = rawPolicyList.map((rawPolicy) => ({
    defaultDecision: rawPolicy.defaultDecision,
    rules: rawPolicy.rules.map((rule) => ({
      decision: rule.decision,
      when: rule.conditions
        .map(({ attr, value }): [number, number] => [attrIndex.get(attr)!, valueIndex[attrIndex.get(attr)!]!.get(value)!])
        .sort((left, right) => left[0] - right[0]),
    })),
  }));
  let budget = DEFAULT_BUDGET;
  if (raw.budget !== undefined) {
    if (typeof raw.budget !== "number" || !Number.isInteger(raw.budget) || raw.budget < 1) {
      fail("budget 必须是正整数");
    }
    budget = raw.budget;
  }
  return {
    attributeNames,
    domains,
    policyNames: [policyNames[0]!, policyNames[1]!],
    policies: [policies[0]!, policies[1]!],
    budget,
  };
}

function isConsistent(rule: Rule, assignment: number[]): boolean {
  for (const [attr, value] of rule.when) {
    if (assignment[attr] !== -1 && assignment[attr] !== value) return false;
  }
  return true;
}

export function possibleDecisions(policy: Policy, domains: string[][], assignment: number[]): Set<string> {
  const live: Rule[] = [];
  for (const rule of policy.rules) {
    if (isConsistent(rule, assignment)) live.push(rule);
  }
  if (live.length === 0) return new Set([policy.defaultDecision]);
  const first = live[0]!;
  const out = new Set<string>([first.decision]);
  for (const [attr, value] of first.when) {
    if (assignment[attr] !== -1) continue;
    const domain = domains[attr]!;
    for (let alt = 0; alt < domain.length; alt++) {
      if (alt === value) continue;
      const extended = assignment.slice();
      extended[attr] = alt;
      for (const decision of possibleDecisions(policy, domains, extended)) out.add(decision);
    }
  }
  return out;
}

export function decidedDecision(policy: Policy, domains: string[][], assignment: number[]): string | null {
  const decisions = possibleDecisions(policy, domains, assignment);
  if (decisions.size !== 1) return null;
  return decisions.values().next().value as string;
}

export function possibleDecisionsBrute(policy: Policy, domains: string[][], assignment: number[]): Set<string> {
  const out = new Set<string>();
  const completion = assignment.slice();
  const free: number[] = [];
  for (let attr = 0; attr < domains.length; attr++) {
    if (assignment[attr] === -1) free.push(attr);
  }
  const cursor = new Array(free.length).fill(0);
  for (;;) {
    for (let i = 0; i < free.length; i++) completion[free[i]!] = cursor[i]!;
    let decision = policy.defaultDecision;
    for (const rule of policy.rules) {
      let matches = true;
      for (const [attr, value] of rule.when) {
        if (completion[attr] !== value) {
          matches = false;
          break;
        }
      }
      if (matches) {
        decision = rule.decision;
        break;
      }
    }
    out.add(decision);
    let pos = free.length - 1;
    while (pos >= 0) {
      cursor[pos]!++;
      if (cursor[pos]! < domains[free[pos]!]!.length) break;
      cursor[pos] = 0;
      pos--;
    }
    if (pos < 0) return out;
  }
}
