import { resolveRefChain, type Schema, type SchemaDocument } from './schema.js';
import { childPath, indexPath } from './paths.js';
import {
  cycleError,
  oneOfAmbiguousError,
  oneOfNoneError,
  refLoopError,
  requiredError,
  sortErrors,
  typeError,
  type ValidationError,
} from './errors.js';

// Schemas already expanded at the current data value without consuming any
// of it. A repeat means the schema recurses through oneOf/$ref forever
// without ever inspecting the data, which is a schema-level error.
const EMPTY_SPINE: ReadonlySet<Schema> = new Set();

type Frame =
  | { readonly kind: 'exit'; readonly value: unknown }
  | {
      readonly kind: 'check';
      readonly value: unknown;
      readonly schema: Schema;
      readonly path: string;
      readonly spine: ReadonlySet<Schema>;
      readonly sink: ValidationError[];
    }
  | {
      readonly kind: 'aggregate';
      readonly path: string;
      readonly branchCount: number;
      readonly buffers: readonly ValidationError[][];
      readonly sink: ValidationError[];
    };

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Primary engine: a single explicit stack machine. Data traversal, oneOf
// branch evaluation and result aggregation are all frames on one stack, so
// data of any depth or shape (e.g. a 200k-node linked list through a
// recursive $ref wrapped in oneOf) is validated without growing the call
// stack. The ancestor chain of the current position is tracked in a shared
// set with enter/exit frames (strictly nested on the same stack), giving
// O(1) cycle checks and O(depth) memory.
export function validate(value: unknown, doc: SchemaDocument): ValidationError[] {
  const errors: ValidationError[] = [];
  const ancestors = new Set<unknown>();
  const stack: Frame[] = [
    { kind: 'check', value, schema: doc.root, path: '$', spine: EMPTY_SPINE, sink: errors },
  ];

  while (stack.length > 0) {
    const frame = stack.pop() as Frame;

    if (frame.kind === 'exit') {
      ancestors.delete(frame.value);
      continue;
    }

    if (frame.kind === 'aggregate') {
      const matched: number[] = [];
      for (let i = 0; i < frame.buffers.length; i += 1) {
        if ((frame.buffers[i] as ValidationError[]).length === 0) matched.push(i);
      }
      if (matched.length === 1) continue;
      if (matched.length === 0) {
        frame.sink.push(oneOfNoneError(frame.path, frame.branchCount));
      } else {
        frame.sink.push(oneOfAmbiguousError(frame.path, matched, frame.branchCount));
      }
      continue;
    }

    // frame.kind === 'check'
    if (frame.spine.has(frame.schema)) {
      frame.sink.push(refLoopError(frame.path));
      continue;
    }
    const resolved = resolveRefChain(frame.schema, doc);
    if (!resolved.ok) {
      frame.sink.push({ path: frame.path, code: resolved.code, message: resolved.message });
      continue;
    }
    const s = resolved.schema;

    if ('oneOf' in s) {
      // Each branch validates into its own buffer; the aggregate frame below
      // the branch frames decides the outcome once all branches finished.
      const buffers = s.oneOf.map(() => [] as ValidationError[]);
      const branchSpine = new Set(frame.spine);
      branchSpine.add(frame.schema);
      stack.push({
        kind: 'aggregate',
        path: frame.path,
        branchCount: s.oneOf.length,
        buffers,
        sink: frame.sink,
      });
      for (let i = s.oneOf.length - 1; i >= 0; i -= 1) {
        stack.push({
          kind: 'check',
          value: frame.value,
          schema: s.oneOf[i] as Schema,
          path: frame.path,
          spine: branchSpine,
          sink: buffers[i] as ValidationError[],
        });
      }
      continue;
    }

    if (s.type === 'integer') {
      if (!(typeof frame.value === 'number' && Number.isInteger(frame.value))) {
        frame.sink.push(typeError(frame.path, 'integer', frame.value));
      }
      continue;
    }

    if (s.type === 'object') {
      if (!isObjectLike(frame.value)) {
        frame.sink.push(typeError(frame.path, 'object', frame.value));
        continue;
      }
      if (ancestors.has(frame.value)) {
        frame.sink.push(cycleError(frame.path, 'object'));
        continue;
      }
      ancestors.add(frame.value);
      stack.push({ kind: 'exit', value: frame.value });
      for (const key of s.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(frame.value, key)) {
          frame.sink.push(requiredError(frame.path, key));
        }
      }
      const keys = Object.keys(s.properties);
      for (let i = keys.length - 1; i >= 0; i -= 1) {
        const key = keys[i] as string;
        if (Object.prototype.hasOwnProperty.call(frame.value, key)) {
          stack.push({
            kind: 'check',
            value: frame.value[key],
            schema: s.properties[key] as Schema,
            path: childPath(frame.path, key),
            spine: EMPTY_SPINE,
            sink: frame.sink,
          });
        }
      }
      continue;
    }

    // s.type === 'array'
    if (!Array.isArray(frame.value)) {
      frame.sink.push(typeError(frame.path, 'array', frame.value));
      continue;
    }
    if (ancestors.has(frame.value)) {
      frame.sink.push(cycleError(frame.path, 'array'));
      continue;
    }
    ancestors.add(frame.value);
    stack.push({ kind: 'exit', value: frame.value });
    for (let i = frame.value.length - 1; i >= 0; i -= 1) {
      stack.push({
        kind: 'check',
        value: frame.value[i],
        schema: s.items,
        path: indexPath(frame.path, i),
        spine: EMPTY_SPINE,
        sink: frame.sink,
      });
    }
  }

  return sortErrors(errors);
}
