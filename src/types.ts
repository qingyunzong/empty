export type Value = string | number | boolean;
export type Effect = "permit" | "deny";

export interface AttributeSpec {
  name: string;
  domain: Value[];
}

export type Condition =
  | { kind: "eq"; attr: string; value: Value }
  | { kind: "ne"; attr: string; value: Value }
  | { kind: "in"; attr: string; values: Value[] };

export interface Rule {
  conditions: Condition[];
  effect: Effect;
}

export interface Policy {
  name: string;
  rules: Rule[];
  defaultEffect: Effect;
}

export interface Spec {
  attributes: AttributeSpec[];
  policies: [Policy, Policy];
  budget: number | undefined;
}

/** A partial assignment: attribute name -> chosen domain value. */
export type Assignment = ReadonlyMap<string, Value>;
