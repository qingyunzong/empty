import type {
  PathSegment,
  RootSchema,
  Schema,
  ValidationError,
} from "./schema.js";
import {
  EMPTY_CHAIN,
  NON_PRODUCTIVE_SCHEMA_MESSAGE,
  resolveRef,
  sortErrors,
} from "./schema.js";

// Paths are stored as a persistent chain so that descending one level costs
// O(1) instead of copying an ever-growing array. The array form is only
// materialized when an error is actually reported.
interface PathNode {
  segment: PathSegment;
  parent: PathNode | null;
}

function pathToArray(node: PathNode | null): PathSegment[] {
  const out: PathSegment[] = [];
  for (let current = node; current !== null; current = current.parent) {
    out.push(current.segment);
  }
  return out.reverse();
}

// Errors are collected with their lazy path chain; the array form is only
// materialized for errors that survive to the final result. oneOf branch
// sinks are discarded after counting, so they never pay for path building.
interface LazyError {
  path: PathNode | null;
  message: string;
}

interface VisitFrame {
  kind: "visit";
  schema: Schema;
  value: unknown;
  path: PathNode | null;
  sink: LazyError[];
  chain: ReadonlySet<unknown>;
}

// Pops a container off the ancestor set once its whole subtree is done, so
// the shared set always holds exactly the containers on the current path.
interface ExitFrame {
  kind: "exit";
  value: object;
}

// A join frame evaluates oneOf branches one at a time. It sits below the
// current branch's frames on the explicit stack, so it resurfaces only after
// the whole branch subtree has been processed, keeping oneOf evaluation
// fully iterative even for deeply nested schemas.
interface JoinFrame {
  kind: "join";
  branches: Schema[];
  value: unknown;
  path: PathNode | null;
  sink: LazyError[];
  chain: ReadonlySet<unknown>;
  launched: number;
  matched: number[];
  branchSink: LazyError[];
}

type Frame = VisitFrame | ExitFrame | JoinFrame;

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function isObjectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Iterative validator: an explicit work stack keeps deep schemas/values from
// overflowing the call stack. The ancestor set tracks only the containers on
// the current path, so shared (DAG) subvalues are allowed while true cycles
// are rejected.
export function validate(root: RootSchema, value: unknown): ValidationError[] {
  const lazy: LazyError[] = [];
  collect(root, root, value, null, new Set<object>(), lazy);
  const errors: ValidationError[] = lazy.map((error) => ({
    path: pathToArray(error.path),
    message: error.message,
  }));
  return sortErrors(errors);
}

function collect(
  root: RootSchema,
  schema: Schema,
  value: unknown,
  path: PathNode | null,
  ancestors: Set<object>,
  sink: LazyError[],
): void {
  const stack: Frame[] = [
    { kind: "visit", schema, value, path, sink, chain: EMPTY_CHAIN },
  ];
  while (stack.length > 0) {
    const frame = stack.pop()!;

    if (frame.kind === "exit") {
      ancestors.delete(frame.value);
      continue;
    }

    if (frame.kind === "join") {
      if (frame.branchSink.length === 0) {
        frame.matched.push(frame.launched - 1);
      }
      if (frame.launched < frame.branches.length) {
        const branch = frame.branches[frame.launched]!;
        frame.launched++;
        frame.branchSink = [];
        stack.push(frame);
        stack.push({
          kind: "visit",
          schema: branch,
          value: frame.value,
          path: frame.path,
          sink: frame.branchSink,
          chain: frame.chain,
        });
      } else if (frame.matched.length === 0) {
        frame.sink.push({
          path: frame.path,
          message: "oneOf: no branch matched",
        });
      } else if (frame.matched.length > 1) {
        frame.sink.push({
          path: frame.path,
          message: `oneOf: ambiguous, branches [${frame.matched.join(", ")}] all matched`,
        });
      }
      continue;
    }

    const resolved = resolveRef(frame.schema, root);

    if ("oneOf" in resolved) {
      if (frame.chain.has(resolved)) {
        throw new Error(NON_PRODUCTIVE_SCHEMA_MESSAGE);
      }
      const branchChain = new Set(frame.chain).add(resolved);
      if (resolved.oneOf.length === 0) {
        frame.sink.push({
          path: frame.path,
          message: "oneOf: no branch matched",
        });
        continue;
      }
      const join: JoinFrame = {
        kind: "join",
        branches: resolved.oneOf,
        value: frame.value,
        path: frame.path,
        sink: frame.sink,
        chain: branchChain,
        launched: 1,
        matched: [],
        branchSink: [],
      };
      stack.push(join);
      stack.push({
        kind: "visit",
        schema: resolved.oneOf[0]!,
        value: frame.value,
        path: frame.path,
        sink: join.branchSink,
        chain: branchChain,
      });
      continue;
    }

    switch (resolved.type) {
      case "integer": {
        if (
          !(
            typeof frame.value === "number" &&
            Number.isInteger(frame.value)
          )
        ) {
          frame.sink.push({
            path: frame.path,
            message: `expected integer, got ${describe(frame.value)}`,
          });
        }
        break;
      }
      case "object": {
        if (!isObjectValue(frame.value)) {
          frame.sink.push({
            path: frame.path,
            message: `expected object, got ${describe(frame.value)}`,
          });
          break;
        }
        if (ancestors.has(frame.value)) {
          frame.sink.push({
            path: frame.path,
            message: "circular reference in value",
          });
          break;
        }
        for (const key of resolved.required ?? []) {
          if (!Object.prototype.hasOwnProperty.call(frame.value, key)) {
            frame.sink.push({
              path: frame.path,
              message: `missing required property ${JSON.stringify(key)}`,
            });
          }
        }
        ancestors.add(frame.value);
        stack.push({ kind: "exit", value: frame.value });
        for (const key of Object.keys(resolved.properties ?? {})) {
          if (Object.prototype.hasOwnProperty.call(frame.value, key)) {
            stack.push({
              kind: "visit",
              schema: resolved.properties![key]!,
              value: frame.value[key],
              path: { segment: key, parent: frame.path },
              sink: frame.sink,
              chain: EMPTY_CHAIN,
            });
          }
        }
        break;
      }
      case "array": {
        if (!Array.isArray(frame.value)) {
          frame.sink.push({
            path: frame.path,
            message: `expected array, got ${describe(frame.value)}`,
          });
          break;
        }
        if (ancestors.has(frame.value)) {
          frame.sink.push({
            path: frame.path,
            message: "circular reference in value",
          });
          break;
        }
        ancestors.add(frame.value);
        stack.push({ kind: "exit", value: frame.value });
        for (let i = 0; i < frame.value.length; i++) {
          stack.push({
            kind: "visit",
            schema: resolved.items,
            value: frame.value[i],
            path: { segment: i, parent: frame.path },
            sink: frame.sink,
            chain: EMPTY_CHAIN,
          });
        }
        break;
      }
    }
  }
}
