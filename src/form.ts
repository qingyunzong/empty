import {
  Expr,
  assertMonotone,
  evaluate,
  referencedFields,
} from './expr.js';

export interface FieldDef {
  name: string;
  condition: Expr;
}

export interface RoundInfo {
  /** 1-based round index of the fixed-point iteration. */
  round: number;
  /** Fields that became visible in this round. */
  revealed: string[];
  /** Sorted snapshot of the full visible set after this round. */
  visibleAfter: string[];
}

export interface VisibilityResult {
  visible: ReadonlySet<string>;
  rounds: RoundInfo[];
}

/**
 * Least fixed point of the visibility operator, computed by monotone
 * iteration starting from the all-hidden state. Each round evaluates all
 * still-hidden fields against the visible set of the previous round
 * (round-atomic), so the visible set only grows.
 */
export function computeVisibility(
  fields: readonly FieldDef[],
  values: Readonly<Record<string, boolean | undefined>>,
): VisibilityResult {
  const visible = new Set<string>();
  const rounds: RoundInfo[] = [];
  for (;;) {
    const ctx = { values, visible };
    const revealed = fields
      .filter((f) => !visible.has(f.name) && evaluate(f.condition, ctx))
      .map((f) => f.name);
    if (revealed.length === 0) break;
    for (const name of revealed) visible.add(name);
    rounds.push({
      round: rounds.length + 1,
      revealed,
      visibleAfter: [...visible].sort(),
    });
  }
  return { visible, rounds };
}

export interface BatchResult extends VisibilityResult {
  /** Fields newly visible compared to the state before the batch. */
  becameVisible: string[];
  /** Fields newly hidden compared to the state before the batch. */
  becameHidden: string[];
}

export class UnknownFieldError extends Error {
  constructor(name: string) {
    super(`Unknown field: "${name}"`);
    this.name = 'UnknownFieldError';
  }
}

export class Form {
  readonly fields: readonly FieldDef[];
  private readonly fieldNames: Set<string>;
  private values: Record<string, boolean | undefined>;
  private state: VisibilityResult;

  constructor(
    fields: readonly FieldDef[],
    initialValues: Readonly<Record<string, boolean | undefined>> = {},
  ) {
    const names = new Set<string>();
    for (const f of fields) {
      if (names.has(f.name)) {
        throw new Error(`Duplicate field name: "${f.name}"`);
      }
      names.add(f.name);
    }
    for (const f of fields) {
      assertMonotone(f.condition);
      for (const ref of referencedFields(f.condition)) {
        if (!names.has(ref)) {
          throw new UnknownFieldError(ref);
        }
      }
    }
    for (const key of Object.keys(initialValues)) {
      if (!names.has(key)) throw new UnknownFieldError(key);
    }
    this.fields = fields;
    this.fieldNames = names;
    this.values = { ...initialValues };
    this.state = computeVisibility(this.fields, this.values);
  }

  get visible(): ReadonlySet<string> {
    return this.state.visible;
  }

  isVisible(name: string): boolean {
    return this.state.visible.has(name);
  }

  /** Value as seen by consumers: hidden fields are unfilled (undefined). */
  effectiveValue(name: string): boolean | undefined {
    if (!this.fieldNames.has(name)) throw new UnknownFieldError(name);
    return this.state.visible.has(name) ? this.values[name] : undefined;
  }

  effectiveValues(): Record<string, boolean | undefined> {
    const out: Record<string, boolean | undefined> = {};
    for (const f of this.fields) out[f.name] = this.effectiveValue(f.name);
    return out;
  }

  /**
   * Applies a whole batch of value changes atomically: the patch is merged
   * first, then visibility is recomputed exactly once as a least fixed
   * point from the all-hidden state. Returns the per-round changes of that
   * iteration plus the diff against the previous state.
   */
  applyBatch(
    patch: Readonly<Record<string, boolean | undefined>>,
  ): BatchResult {
    const next: Record<string, boolean | undefined> = { ...this.values };
    for (const [key, value] of Object.entries(patch)) {
      if (!this.fieldNames.has(key)) throw new UnknownFieldError(key);
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    const result = computeVisibility(this.fields, next);
    const becameVisible = [...result.visible]
      .filter((f) => !this.state.visible.has(f))
      .sort();
    const becameHidden = [...this.state.visible]
      .filter((f) => !result.visible.has(f))
      .sort();
    this.values = next;
    this.state = result;
    return { ...result, becameVisible, becameHidden };
  }
}
