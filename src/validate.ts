import {
  ExtractionError,
  type CounterStyle,
  type ParsedNode,
} from "./types.js";

export interface NormalizedLiteralToken {
  kind: "literal";
  text: string;
}

export interface NormalizedCounterToken {
  kind: "counter";
  name: string;
  style: CounterStyle;
}

export interface NormalizedCountersToken {
  kind: "counters";
  name: string;
  separator: string;
  style: CounterStyle;
}

export type NormalizedContentToken =
  | NormalizedLiteralToken
  | NormalizedCounterToken
  | NormalizedCountersToken;

export interface NormalizedAssignment {
  name: string;
  value: bigint;
}

export interface NormalizedNode {
  id: string;
  before: readonly NormalizedContentToken[];
  after: readonly NormalizedContentToken[];
  children: readonly ParsedNode[];
  reset: readonly NormalizedAssignment[];
  set: readonly NormalizedAssignment[];
  increment: readonly NormalizedAssignment[];
  skipSubtree: boolean;
  suppressText: boolean;
}

export interface NormalizedInput {
  roots: readonly ParsedNode[];
  initialCounters: ReadonlyMap<string, bigint>;
  outputByteBudget: bigint | null;
  plans: ReadonlyMap<ParsedNode, NormalizedNode>;
}

const INITIAL_SOURCE = "$initial";

function fail(
  code: ConstructorParameters<typeof ExtractionError>[0],
  message: string,
  path?: string,
): never {
  throw new ExtractionError(code, message, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function parseInteger(
  value: unknown,
  code: "INVALID_NUMBER" | "INVALID_INPUT",
  path: string,
  description: string,
): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      fail(code, `${description} must be a safe integer or bigint`, path);
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^[+-]?\d+$/.test(value)) {
    return BigInt(value);
  }
  return fail(
    code,
    `${description} must be an integer number, bigint, or decimal integer string`,
    path,
  );
}

function parseBudget(value: unknown): bigint | null {
  if (value === undefined) {
    return null;
  }
  const budget = parseInteger(
    value,
    "INVALID_INPUT",
    "$.outputByteBudget",
    "output byte budget",
  );
  if (budget < 0n) {
    fail("INVALID_INPUT", "output byte budget cannot be negative", "$.outputByteBudget");
  }
  return budget;
}

function readInitialCounters(
  input: Record<string, unknown>,
): ReadonlyMap<string, bigint> {
  const aliases = ["initialCounters", "initialValues"] as const;
  const present = aliases.filter((key) => own(input, key));
  if (present.length !== 1) {
    fail(
      "INVALID_INPUT",
      "exactly one of initialCounters or initialValues must be provided",
      "$",
    );
  }

  const raw = input[present[0]];
  const counters = new Map<string, bigint>();

  if (Array.isArray(raw)) {
    for (let index = 0; index < raw.length; index += 1) {
      const declaration = raw[index];
      const path = `$.${present[0]}[${index}]`;
      if (!isRecord(declaration)) {
        fail("INVALID_INPUT", "counter declaration must be an object", path);
      }
      const name = declaration.name;
      if (typeof name !== "string" || name.length === 0) {
        fail("INVALID_INPUT", "declared counter name must be a non-empty string", `${path}.name`);
      }
      if (counters.has(name)) {
        fail("INVALID_INPUT", `counter "${name}" is declared more than once`, path);
      }
      if (!own(declaration, "value")) {
        fail("INVALID_INPUT", "counter declaration is missing value", path);
      }
      counters.set(
        name,
        parseInteger(declaration.value, "INVALID_INPUT", `${path}.value`, `initial value for "${name}"`),
      );
    }
    return counters;
  }

  if (!isRecord(raw)) {
    fail(
      "INVALID_INPUT",
      "initial counters must be an object map or an array of declarations",
      `$.${present[0]}`,
    );
  }

  for (const [name, value] of Object.entries(raw)) {
    if (name.length === 0) {
      fail("INVALID_INPUT", "declared counter name must be non-empty", `$.${present[0]}`);
    }
    counters.set(
      name,
      parseInteger(
        value,
        "INVALID_INPUT",
        `$.${present[0]}[${JSON.stringify(name)}]`,
        `initial value for "${name}"`,
      ),
    );
  }
  return counters;
}

function readRoots(input: Record<string, unknown>): readonly ParsedNode[] {
  const aliases = ["roots", "rootNodes"] as const;
  const present = aliases.filter((key) => own(input, key));
  if (present.length !== 1) {
    fail("INVALID_INPUT", "exactly one of roots or rootNodes must be provided", "$");
  }
  const roots = input[present[0]];
  if (!Array.isArray(roots)) {
    fail("INVALID_INPUT", "roots must be an array of nodes", `$.${present[0]}`);
  }
  return roots as ParsedNode[];
}

function readInstructions(
  node: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  const tableKeys = ["instructions", "directives"] as const;
  const directKeys = ["reset", "set", "increment"] as const;
  const presentTables = tableKeys.filter((key) => own(node, key));
  const presentDirect = directKeys.filter((key) => own(node, key));

  if (presentTables.length > 1) {
    fail("INVALID_INPUT", "both instructions and directives were provided", path);
  }
  if (presentTables.length === 1 && presentDirect.length > 0) {
    fail(
      "INVALID_INPUT",
      "instructions cannot be mixed with direct reset/set/increment fields",
      path,
    );
  }

  if (presentTables.length === 1) {
    const table = node[presentTables[0]];
    if (!isRecord(table)) {
      fail("INVALID_INPUT", `${presentTables[0]} must be an object`, `${path}.${presentTables[0]}`);
    }
    return table;
  }

  if (presentDirect.length > 0) {
    return node;
  }
  return {};
}

function readList(
  table: Record<string, unknown>,
  key: "reset" | "set" | "increment",
  path: string,
): readonly unknown[] {
  if (!own(table, key)) {
    return [];
  }
  const value = table[key];
  if (!Array.isArray(value)) {
    fail("INVALID_INPUT", `${key} must be an ordered array`, `${path}.${key}`);
  }
  return value;
}

function parseAssignment(
  entry: unknown,
  path: string,
  kind: "reset" | "set" | "increment",
  allowImplicitValue: boolean,
): NormalizedAssignment {
  if (!isRecord(entry)) {
    fail("INVALID_INPUT", `${kind} entry must be an object`, path);
  }
  if (typeof entry.name !== "string" || entry.name.length === 0) {
    fail("INVALID_INPUT", `${kind} entry has an invalid name`, `${path}.name`);
  }

  let value: unknown;
  if (kind === "increment") {
    if (own(entry, "value") && own(entry, "by")) {
      fail("INVALID_INPUT", "increment cannot contain both value and by", path);
    }
    value = own(entry, "value") ? entry.value : entry.by;
  } else {
    value = own(entry, "value") ? entry.value : undefined;
  }

  if (value === undefined && allowImplicitValue) {
    return { name: entry.name, value: 0n };
  }
  if (value === undefined) {
    fail("INVALID_INPUT", `${kind} entry is missing an integer value`, path);
  }
  return {
    name: entry.name,
    value: parseInteger(
      value,
      "INVALID_NUMBER",
      `${path}.value`,
      `${kind} value for "${entry.name}"`,
    ),
  };
}

function normalizeInstructions(
  node: Record<string, unknown>,
  path: string,
  declared: ReadonlyMap<string, bigint>,
): Pick<NormalizedNode, "reset" | "set" | "increment"> {
  const table = readInstructions(node, path);
  const resetRaw = readList(table, "reset", path);
  const setRaw = readList(table, "set", path);
  const incrementRaw = readList(table, "increment", path);

  const reset: NormalizedAssignment[] = [];
  const set: NormalizedAssignment[] = [];
  const increment: NormalizedAssignment[] = [];
  const resetNames = new Set<string>();
  const setNames = new Set<string>();
  const incrementNames = new Set<string>();

  for (let index = 0; index < resetRaw.length; index += 1) {
    const entry = resetRaw[index];
    const entryPath = `${path}.instructions.reset[${index}]`;
    let name: string;
    let value: bigint;
    if (typeof entry === "string") {
      name = entry;
      value = 0n;
    } else {
      const assignment = parseAssignment(entry, entryPath, "reset", true);
      name = assignment.name;
      value = assignment.value;
    }
    if (name.length === 0) {
      fail("INVALID_INPUT", "reset name must be non-empty", entryPath);
    }
    if (!declared.has(name)) {
      fail("UNKNOWN_COUNTER", `unknown counter "${name}"`, entryPath);
    }
    if (resetNames.has(name)) {
      fail("DUPLICATE_INSTRUCTION", `duplicate reset for counter "${name}"`, entryPath);
    }
    resetNames.add(name);
    reset.push({ name, value });
  }

  const parseNamedList = (
    entries: readonly unknown[],
    kind: "set" | "increment",
    output: NormalizedAssignment[],
    seen: Set<string>,
  ): void => {
    for (let index = 0; index < entries.length; index += 1) {
      const entryPath = `${path}.instructions.${kind}[${index}]`;
      const assignment = parseAssignment(entries[index], entryPath, kind, false);
      if (!declared.has(assignment.name)) {
        fail(
          "UNKNOWN_COUNTER",
          `unknown counter "${assignment.name}"`,
          entryPath,
        );
      }
      if (seen.has(assignment.name)) {
        fail(
          "DUPLICATE_INSTRUCTION",
          `duplicate ${kind} for counter "${assignment.name}"`,
          entryPath,
        );
      }
      seen.add(assignment.name);
      output.push(assignment);
    }
  };

  parseNamedList(setRaw, "set", set, setNames);
  parseNamedList(incrementRaw, "increment", increment, incrementNames);
  return { reset, set, increment };
}

function parseStyle(value: unknown, path: string): CounterStyle {
  if (value === "decimal" || value === "lower-alpha") {
    return value;
  }
  return fail(
    "INVALID_TOKEN",
    'counter style must be "decimal" or "lower-alpha"',
    path,
  );
}

function normalizeToken(
  token: unknown,
  path: string,
  declared: ReadonlyMap<string, bigint>,
): NormalizedContentToken {
  if (!isRecord(token)) {
    fail("INVALID_TOKEN", "content token must be an object", path);
  }

  if (own(token, "kind") && own(token, "type") && token.kind !== token.type) {
    fail("INVALID_TOKEN", "token kind and type disagree", path);
  }
  const kind = own(token, "kind") ? token.kind : token.type;

  if (kind === "literal") {
    if (own(token, "value") && own(token, "text") && token.value !== token.text) {
      fail("INVALID_TOKEN", "literal value and text disagree", path);
    }
    const text = own(token, "value") ? token.value : token.text;
    if (typeof text !== "string") {
      fail("INVALID_TOKEN", "literal token requires a string value", path);
    }
    return { kind: "literal", text };
  }

  if (kind === "counter" || kind === "counters") {
    const name = token.name;
    if (typeof name !== "string" || name.length === 0) {
      fail("INVALID_TOKEN", `${kind} token requires a counter name`, path);
    }
    if (!declared.has(name)) {
      fail("UNKNOWN_COUNTER", `unknown counter "${name}"`, path);
    }
    const style = parseStyle(token.style, `${path}.style`);
    if (kind === "counter") {
      return { kind, name, style };
    }

    if (own(token, "separator") && own(token, "sep") && token.separator !== token.sep) {
      fail("INVALID_TOKEN", "counters separator and sep disagree", path);
    }
    const separator = own(token, "separator") ? token.separator : token.sep;
    if (typeof separator !== "string") {
      fail("INVALID_TOKEN", "counters token requires a string separator", path);
    }
    return { kind, name, separator, style };
  }

  return fail("INVALID_TOKEN", 'token kind must be "literal", "counter", or "counters"', path);
}

function readTokens(
  node: Record<string, unknown>,
  key: "before" | "after",
  path: string,
  declared: ReadonlyMap<string, bigint>,
): readonly NormalizedContentToken[] {
  if (!own(node, key)) {
    return [];
  }
  const raw = node[key];
  if (!Array.isArray(raw)) {
    fail("INVALID_TOKEN", `${key} must be an ordered array of tokens`, `${path}.${key}`);
  }
  return raw.map((token, index) =>
    normalizeToken(token, `${path}.${key}[${index}]`, declared),
  );
}

function parseNodePlan(
  node: Record<string, unknown>,
  path: string,
  declared: ReadonlyMap<string, bigint>,
): NormalizedNode {
  const id = node.id;
  if (typeof id !== "string" || id.length === 0) {
    fail("INVALID_TREE", "node id must be a non-empty string", `${path}.id`);
  }
  if (id === INITIAL_SOURCE) {
    fail("INVALID_TREE", `node id "${INITIAL_SOURCE}" is reserved`, `${path}.id`);
  }

  const skipSubtree = node.skipSubtree;
  if (skipSubtree !== undefined && typeof skipSubtree !== "boolean") {
    fail("INVALID_TREE", "skipSubtree must be a boolean", `${path}.skipSubtree`);
  }
  const suppressText = node.suppressText;
  if (suppressText !== undefined && typeof suppressText !== "boolean") {
    fail("INVALID_TREE", "suppressText must be a boolean", `${path}.suppressText`);
  }

  let children: readonly ParsedNode[] = [];
  if (own(node, "children")) {
    if (!Array.isArray(node.children)) {
      fail("INVALID_TREE", "children must be an array of nodes", `${path}.children`);
    }
    children = node.children as ParsedNode[];
  }

  return {
    id,
    before: readTokens(node, "before", path, declared),
    after: readTokens(node, "after", path, declared),
    children,
    ...normalizeInstructions(node, path, declared),
    skipSubtree: skipSubtree === true,
    suppressText: suppressText === true,
  };
}

export function normalizeInput(input: unknown): NormalizedInput {
  if (!isRecord(input)) {
    fail("INVALID_INPUT", "extraction input must be an object", "$");
  }
  const roots = readRoots(input);
  const initialCounters = readInitialCounters(input);
  const budgetAliases = ["outputByteBudget", "maxOutputBytes"] as const;
  const presentBudget = budgetAliases.filter((key) => own(input, key));
  if (presentBudget.length > 1) {
    fail("INVALID_INPUT", "outputByteBudget and maxOutputBytes cannot both be provided", "$");
  }
  const outputByteBudget =
    presentBudget.length === 0 ? null : parseBudget(input[presentBudget[0]]);

  const plans = new Map<ParsedNode, NormalizedNode>();
  const seenIds = new Map<string, ParsedNode>();
  const parentOf = new WeakMap<object, string>();
  const active = new Set<object>();

  interface Frame {
    node: ParsedNode;
    path: string;
    parentId: string;
    exit: boolean;
  }

  const stack: Frame[] = [];
  for (let index = roots.length - 1; index >= 0; index -= 1) {
    stack.push({
      node: roots[index],
      path: `$.roots[${index}]`,
      parentId: INITIAL_SOURCE,
      exit: false,
    });
  }

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.exit) {
      active.delete(frame.node);
      continue;
    }

    if (!isRecord(frame.node)) {
      fail("INVALID_TREE", "node must be an object", frame.path);
    }
    if (active.has(frame.node)) {
      fail("CYCLE", `node "${String(frame.node.id)}" is its own ancestor`, frame.path);
    }
    if (parentOf.has(frame.node)) {
      fail(
        "MULTIPLE_PARENTS",
        `node "${String(frame.node.id)}" is reachable from more than one parent`,
        frame.path,
      );
    }

    const plan = parseNodePlan(frame.node, frame.path, initialCounters);
    if (seenIds.has(plan.id)) {
      fail("DUPLICATE_ID", `duplicate node id "${plan.id}"`, `${frame.path}.id`);
    }
    seenIds.set(plan.id, frame.node);
    parentOf.set(frame.node, frame.parentId);
    active.add(frame.node);
    plans.set(frame.node, plan);
    stack.push({ ...frame, exit: true });

    for (let index = plan.children.length - 1; index >= 0; index -= 1) {
      stack.push({
        node: plan.children[index],
        path: `${frame.path}.children[${index}]`,
        parentId: plan.id,
        exit: false,
      });
    }
  }

  return { roots, initialCounters, outputByteBudget, plans };
}
