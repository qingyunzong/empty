/**
 * test-explainer: 测试解释库
 *
 * 核心能力:
 * - 断言可依赖多个输入, 通过 Proxy 动态追踪实际读取的输入键。
 * - 断言失败时返回最小原因切片: 贪心穷举移除输入, 直至 1-最小。
 * - 条件未执行分支中的输入不会被读取, 因此不计入来源。
 * - 错误(非断言异常)与断言失败严格分开, 错误不产生原因切片。
 * - 读取缺失输入抛出 MissingInputError (归类为错误), 保证原因切片自包含、可重放。
 * - 输入至多 20 个, 保证穷举移除验证在可接受时间内完成。
 * - 输出可重放证据: 证据中包含最小输入集与重放验证结果。
 */

export const MAX_INPUTS = 20;

export type Inputs = Record<string, unknown>;

/** 断言失败专用错误类型, 与普通错误区分。 */
export class AssertionFailure extends Error {
  override readonly name = 'AssertionFailure';
}

/** 读取了未提供的输入键; 归类为错误而非断言失败。 */
export class MissingInputError extends Error {
  override readonly name = 'MissingInputError';
  constructor(key: string) {
    super(`input not provided: ${key}`);
  }
}

/** 断言: 条件为假时抛出 AssertionFailure。 */
export function assertThat(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new AssertionFailure(message);
  }
}

export type Outcome =
  | { readonly kind: 'pass' }
  | { readonly kind: 'failure'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

export type TestFn = (inputs: Inputs) => void;

/** 运行一次测试, 记录实际读取的输入键, 并把异常分类为 失败/错误。 */
export function runOnce(
  fn: TestFn,
  inputs: Inputs,
): { readonly outcome: Outcome; readonly accessed: readonly string[] } {
  const accessed = new Set<string>();
  const tracked = new Proxy(inputs, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') {
        accessed.add(prop);
        if (!Reflect.has(target, prop)) {
          throw new MissingInputError(prop);
        }
      }
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (typeof prop === 'string') {
        accessed.add(prop);
      }
      return Reflect.has(target, prop);
    },
  });
  try {
    fn(tracked);
    return { outcome: { kind: 'pass' }, accessed: [...accessed] };
  } catch (err) {
    if (err instanceof AssertionFailure) {
      return { outcome: { kind: 'failure', message: err.message }, accessed: [...accessed] };
    }
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { outcome: { kind: 'error', message }, accessed: [...accessed] };
  }
}

function pick(inputs: Inputs, keys: readonly string[]): Inputs {
  const out: Inputs = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(inputs, key)) {
      out[key] = inputs[key];
    }
  }
  return out;
}

function reproduces(fn: TestFn, inputs: Inputs, failureMessage: string): boolean {
  const { outcome } = runOnce(fn, inputs);
  return outcome.kind === 'failure' && outcome.message === failureMessage;
}

/** 贪心穷举移除: 反复尝试移除每个输入, 直到任一移除都无法复现失败 (1-最小)。 */
function minimize(fn: TestFn, inputs: Inputs, keys: readonly string[], failureMessage: string): string[] {
  let current = [...keys];
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of [...current]) {
      const trial = current.filter((k) => k !== key);
      if (reproduces(fn, pick(inputs, trial), failureMessage)) {
        current = trial;
        changed = true;
      }
    }
  }
  return current;
}

export interface MinimalityCheck {
  /** 被移除以验证必要性的输入键。 */
  readonly removed: string;
  /** 移除后失败是否仍复现; 最小原因切片中每一项都应为 false。 */
  readonly reproduced: boolean;
}

export interface ReasonSlice {
  /** 最小原因输入集。 */
  readonly inputs: Inputs;
  /** 已证明与失败无关而被移除的输入键。 */
  readonly removedInputs: readonly string[];
  /** 穷举移除验证: 对切片中每个输入验证其必要性。 */
  readonly minimalityChecks: readonly MinimalityCheck[];
  readonly failure: { readonly message: string };
  /** 重放验证: 仅用最小输入集重跑, 必须复现同一断言失败。 */
  readonly replay: { readonly reproduced: boolean; readonly message: string };
}

export interface Evidence {
  readonly test: string;
  readonly status: 'pass' | 'failure' | 'error';
  /** 原始完整输入。 */
  readonly inputs: Inputs;
  /** 动态依赖切片: 本次执行实际读取的输入键 (未执行分支不计入)。 */
  readonly accessedInputs: readonly string[];
  /** 仅断言失败时存在: 最小原因切片与重放证据。 */
  readonly reason?: ReasonSlice;
  /** 仅错误时存在 (与断言失败分开)。 */
  readonly error?: { readonly message: string };
}

/**
 * 解释一次测试执行。
 * 要求: fn 必须是确定性的 (相同输入产生相同结果), 否则重放证据无效。
 */
export function explain(name: string, fn: TestFn, inputs: Inputs): Evidence {
  const keys = Object.keys(inputs);
  if (keys.length > MAX_INPUTS) {
    throw new RangeError(`too many inputs: ${keys.length} > ${MAX_INPUTS}`);
  }

  const { outcome, accessed } = runOnce(fn, inputs);

  if (outcome.kind === 'pass') {
    return { test: name, status: 'pass', inputs, accessedInputs: accessed };
  }

  if (outcome.kind === 'error') {
    return {
      test: name,
      status: 'error',
      inputs,
      accessedInputs: accessed,
      error: { message: outcome.message },
    };
  }

  const failureMessage = outcome.message;
  const minimalKeys = minimize(fn, inputs, accessed, failureMessage);

  const minimalityChecks: MinimalityCheck[] = minimalKeys.map((key) => ({
    removed: key,
    reproduced: reproduces(fn, pick(inputs, minimalKeys.filter((k) => k !== key)), failureMessage),
  }));

  const replayInputs = pick(inputs, minimalKeys);
  const replayRun = runOnce(fn, replayInputs);
  const replayed =
    replayRun.outcome.kind === 'failure' && replayRun.outcome.message === failureMessage;

  return {
    test: name,
    status: 'failure',
    inputs,
    accessedInputs: accessed,
    reason: {
      inputs: replayInputs,
      removedInputs: accessed.filter((k) => !minimalKeys.includes(k)),
      minimalityChecks,
      failure: { message: failureMessage },
      replay: {
        reproduced: replayed,
        message: replayRun.outcome.kind === 'pass' ? '' : replayRun.outcome.message,
      },
    },
  };
}

/** 独立重放证据: 用证据中的最小输入集重跑 fn, 校验失败是否复现。 */
export function replayEvidence(fn: TestFn, evidence: Evidence): boolean {
  if (evidence.status !== 'failure' || !evidence.reason) {
    return false;
  }
  return reproduces(fn, evidence.reason.inputs, evidence.reason.failure.message);
}
