import { formatCounterValue } from "./format.js";
import {
  ExtractionError,
  type ExtractionInput,
  type ExtractionResult,
  type ExtractionSegment,
  type ParsedNode,
} from "./types.js";
import {
  normalizeInput,
  type NormalizedAssignment,
  type NormalizedContentToken,
  type NormalizedNode,
} from "./validate.js";

interface CounterInstance {
  name: string;
  createdBy: string;
  value: bigint;
}

type CounterStacks = Map<string, CounterInstance[]>;
type LocalInstances = Map<string, CounterInstance>;

type Action =
  | { kind: "group"; nodes: readonly ParsedNode[] }
  | {
      kind: "close-group";
      local: LocalInstances;
    }
  | {
      kind: "node";
      plan: NormalizedNode;
      local: LocalInstances;
    }
  | {
      kind: "after";
      plan: NormalizedNode;
    };

const encoder = new TextEncoder();

function topInstance(
  stacks: CounterStacks,
  name: string,
  nodeId: string,
): CounterInstance {
  const stack = stacks.get(name);
  const instance = stack?.[stack.length - 1];
  if (instance === undefined) {
    throw new Error(`internal error: counter "${name}" has no instance at ${nodeId}`);
  }
  return instance;
}

function applyResets(
  resets: readonly NormalizedAssignment[],
  plan: NormalizedNode,
  local: LocalInstances,
  stacks: CounterStacks,
): void {
  for (const reset of resets) {
    const stack = stacks.get(reset.name);
    if (stack === undefined) {
      throw new Error(`internal error: counter "${reset.name}" is not declared`);
    }

    if (local.has(reset.name)) {
      const replaced = local.get(reset.name)!;
      if (stack[stack.length - 1] !== replaced) {
        throw new Error(`internal error: local counter "${reset.name}" is not innermost`);
      }
      stack.pop();
    }

    const instance: CounterInstance = {
      name: reset.name,
      createdBy: plan.id,
      value: reset.value,
    };
    stack.push(instance);
    local.set(reset.name, instance);
  }
}

function applyModifiers(
  assignments: readonly NormalizedAssignment[],
  stacks: CounterStacks,
  nodeId: string,
): void {
  for (const assignment of assignments) {
    const instance = topInstance(stacks, assignment.name, nodeId);
    instance.value += assignment.value;
  }
}

function readInstance(instance: CounterInstance) {
  return {
    name: instance.name,
    createdBy: instance.createdBy,
    value: instance.value.toString(10),
  };
}

interface Accumulator {
  pieces: string[];
  segments: ExtractionSegment[];
  bytes: bigint;
  budget: bigint | null;
}

function emitToken(
  accumulator: Accumulator,
  planId: string,
  position: "before" | "after",
  tokenIndex: number,
  token: NormalizedContentToken,
  stacks: CounterStacks,
): void {
  let text: string;
  let reads: ExtractionSegment["reads"];

  if (token.kind === "literal") {
    text = token.text;
    reads = [];
  } else if (token.kind === "counter") {
    const instance = topInstance(stacks, token.name, planId);
    text = formatCounterValue(instance.value, token.style);
    reads = [readInstance(instance)];
  } else {
    const stack = stacks.get(token.name);
    if (stack === undefined) {
      throw new Error(`internal error: counter "${token.name}" is not declared`);
    }
    const instances = stack.map(readInstance);
    text = stack
      .map((instance) => formatCounterValue(instance.value, token.style))
      .join(token.separator);
    reads = instances;
  }

  const bytes = BigInt(encoder.encode(text).byteLength);
  if (
    accumulator.budget !== null &&
    accumulator.bytes + bytes > accumulator.budget
  ) {
    throw new ExtractionError(
      "OUTPUT_BUDGET_EXCEEDED",
      `output exceeds the ${accumulator.budget.toString(10)} byte budget`,
    );
  }
  accumulator.bytes += bytes;
  accumulator.pieces.push(text);
  accumulator.segments.push({
    nodeId: planId,
    position,
    tokenIndex,
    kind: token.kind,
    text,
    reads,
  });
}

function emitTokens(
  accumulator: Accumulator,
  plan: NormalizedNode,
  position: "before" | "after",
  stacks: CounterStacks,
): void {
  const tokens = position === "before" ? plan.before : plan.after;
  for (let index = 0; index < tokens.length; index += 1) {
    emitToken(accumulator, plan.id, position, index, tokens[index], stacks);
  }
}

export function extractGeneratedText(input: ExtractionInput): ExtractionResult;
export function extractGeneratedText(input: unknown): ExtractionResult;
export function extractGeneratedText(input: unknown): ExtractionResult {
  const normalized = normalizeInput(input);

  const stacks: CounterStacks = new Map();
  for (const [name, value] of normalized.initialCounters) {
    stacks.set(name, [
      {
        name,
        createdBy: "$initial",
        value,
      },
    ]);
  }

  const accumulator: Accumulator = {
    pieces: [],
    segments: [],
    bytes: 0n,
    budget: normalized.outputByteBudget,
  };
  const actions: Action[] = [{ kind: "group", nodes: normalized.roots }];

  while (actions.length > 0) {
    const action = actions.pop()!;

    if (action.kind === "close-group") {
      for (const instance of action.local.values()) {
        const stack = stacks.get(instance.name)!;
        if (stack[stack.length - 1] !== instance) {
          throw new Error(
            `internal error: cannot close a non-innermost instance for "${instance.name}"`,
          );
        }
        stack.pop();
      }
      continue;
    }

    if (action.kind === "group") {
      const local: LocalInstances = new Map();
      actions.push({ kind: "close-group", local });
      for (let index = action.nodes.length - 1; index >= 0; index -= 1) {
        actions.push({
          kind: "node",
          plan: normalized.plans.get(action.nodes[index])!,
          local,
        });
      }
      continue;
    }

    const plan = action.plan;
    if (action.kind === "after") {
      if (!plan.suppressText) {
        emitTokens(accumulator, plan, "after", stacks);
      }
      continue;
    }

    if (plan.skipSubtree) {
      continue;
    }

    applyResets(plan.reset, plan, action.local, stacks);
    applyModifiers(plan.set, stacks, plan.id);
    applyModifiers(plan.increment, stacks, plan.id);

    if (!plan.suppressText) {
      emitTokens(accumulator, plan, "before", stacks);
      actions.push({ kind: "after", plan });
    }

    if (plan.children.length > 0) {
      actions.push({ kind: "group", nodes: plan.children });
    }
  }

  return {
    text: accumulator.pieces.join(""),
    segments: accumulator.segments,
  };
}

export const extractText = extractGeneratedText;
export const generateCounterText = extractGeneratedText;
