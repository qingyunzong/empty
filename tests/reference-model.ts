interface RefInstance {
  name: string;
  createdBy: string;
  value: bigint;
}

interface RefRead {
  name: string;
  createdBy: string;
  value: string;
}

interface RefSegment {
  nodeId: string;
  position: "before" | "after";
  tokenIndex: number;
  kind: "literal" | "counter" | "counters";
  text: string;
  reads: RefRead[];
}

interface RefInput {
  roots: readonly any[];
  initialCounters:
    | Readonly<Record<string, bigint | number | string>>
    | readonly { name: string; value: bigint | number | string }[];
}

function refAlpha(value: bigint): string {
  if (value <= 0n) {
    return String(value);
  }
  let n = value;
  let result = "";
  while (n > 0n) {
    n -= 1n;
    result = String.fromCharCode(97 + Number(n % 26n)) + result;
    n /= 26n;
  }
  return result;
}

function refFormat(value: bigint, style: string): string {
  return style === "lower-alpha" ? refAlpha(value) : String(value);
}

function refRead(instance: RefInstance): RefRead {
  return {
    name: instance.name,
    createdBy: instance.createdBy,
    value: String(instance.value),
  };
}

export function referenceExtract(input: RefInput) {
  const initial = new Map<string, RefInstance>();
  if (Array.isArray(input.initialCounters)) {
    for (const declaration of input.initialCounters) {
      initial.set(declaration.name, {
        name: declaration.name,
        createdBy: "$initial",
        value: BigInt(declaration.value),
      });
    }
  } else {
    for (const [name, value] of Object.entries(input.initialCounters)) {
      initial.set(name, {
        name,
        createdBy: "$initial",
        value: BigInt(value),
      });
    }
  }

  const stacks = new Map<string, RefInstance[]>();
  for (const instance of initial.values()) {
    stacks.set(instance.name, [instance]);
  }

  const pieces: string[] = [];
  const segments: RefSegment[] = [];

  function current(name: string): RefInstance {
    const stack = stacks.get(name);
    if (!stack) {
      throw new Error(`reference: unknown counter ${name}`);
    }
    return stack[stack.length - 1];
  }

  function emit(
    nodeId: string,
    position: "before" | "after",
    tokenIndex: number,
    token: any,
  ): void {
    if (token.kind === "literal") {
      pieces.push(token.value);
      segments.push({
        nodeId,
        position,
        tokenIndex,
        kind: "literal",
        text: token.value,
        reads: [],
      });
      return;
    }

    if (token.kind === "counter") {
      const instance = current(token.name);
      const text = refFormat(instance.value, token.style);
      pieces.push(text);
      segments.push({
        nodeId,
        position,
        tokenIndex,
        kind: "counter",
        text,
        reads: [refRead(instance)],
      });
      return;
    }

    const stack = stacks.get(token.name)!;
    const text = stack
      .map((instance) => refFormat(instance.value, token.style))
      .join(token.separator);
    pieces.push(text);
    segments.push({
      nodeId,
      position,
      tokenIndex,
      kind: "counters",
      text,
      reads: stack.map(refRead),
    });
  }

  function processGroup(nodes: readonly any[]): void {
    const local = new Map<string, RefInstance>();
    for (const node of nodes) {
      processNode(node, local);
    }
    for (const instance of local.values()) {
      const stack = stacks.get(instance.name)!;
      if (stack[stack.length - 1] !== instance) {
        throw new Error("reference: scope did not close at the innermost instance");
      }
      stack.pop();
    }
  }

  function processNode(node: any, local: Map<string, RefInstance>): void {
    if (node.skipSubtree) {
      return;
    }

    const instructions = node.instructions ?? {};
    for (const entry of instructions.reset ?? []) {
      const name = typeof entry === "string" ? entry : entry.name;
      const value = typeof entry === "string" ? 0n : BigInt(entry.value ?? 0);
      const stack = stacks.get(name)!;
      if (local.has(name)) {
        stack.pop();
      }
      const instance: RefInstance = { name, createdBy: node.id, value };
      stack.push(instance);
      local.set(name, instance);
    }
    for (const assignment of instructions.set ?? []) {
      current(assignment.name).value = BigInt(assignment.value);
    }
    for (const assignment of instructions.increment ?? []) {
      current(assignment.name).value += BigInt(assignment.value);
    }

    if (!node.suppressText) {
      for (let index = 0; index < (node.before?.length ?? 0); index += 1) {
        emit(node.id, "before", index, node.before[index]);
      }
    }

    processGroup(node.children ?? []);

    if (!node.suppressText) {
      for (let index = 0; index < (node.after?.length ?? 0); index += 1) {
        emit(node.id, "after", index, node.after[index]);
      }
    }
  }

  processGroup(input.roots);
  return { text: pieces.join(""), segments };
}
