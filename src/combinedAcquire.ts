/**
 * 组合请求库：同时申请多个资源。
 *
 * 语义：
 * - 并发发起所有 acquire，每个 acquire 收到一个 AbortSignal。
 * - 任一请求失败或超时：立即 abort 其余请求的 signal。
 * - 等待所有 acquire 真正落定（包括“迟到”的 promise），
 *   已成功（含迟到成功）的资源按逆申请顺序各释放一次。
 * - 抛出的错误按申请顺序选择：下标最小的失败原因。
 *   迟到的成功/失败都不会改变已选定的错误。
 */

export interface ResourceRequest<T> {
  acquire: (signal: AbortSignal) => Promise<T> | T;
  release: (resource: T) => void | Promise<void>;
}

export interface AcquireAllOptions {
  /** 每个请求的超时时间（毫秒）。超时视为该请求失败并触发取消。 */
  timeoutMs?: number;
}

export class AcquireTimeoutError extends Error {
  readonly index: number;
  readonly timeoutMs: number;

  constructor(index: number, timeoutMs: number) {
    super(`resource request #${index} timed out after ${timeoutMs}ms`);
    this.name = 'AcquireTimeoutError';
    this.index = index;
    this.timeoutMs = timeoutMs;
  }
}

export async function acquireAll<T>(
  requests: readonly ResourceRequest<T>[],
  options: AcquireAllOptions = {},
): Promise<T[]> {
  const count = requests.length;
  const controllers = requests.map(() => new AbortController());

  const hasError: boolean[] = new Array<boolean>(count).fill(false);
  const errors: unknown[] = new Array<unknown>(count).fill(undefined);
  const hasResource: boolean[] = new Array<boolean>(count).fill(false);
  const resources: (T | undefined)[] = new Array<T | undefined>(count).fill(undefined);

  let cancelled = false;
  const cancelAll = (): void => {
    if (cancelled) return;
    cancelled = true;
    for (const controller of controllers) controller.abort();
  };

  // 每个下标只记录第一个错误；任何失败都会取消其余请求。
  const recordError = (index: number, error: unknown): void => {
    if (!hasError[index]) {
      hasError[index] = true;
      errors[index] = error;
    }
    cancelAll();
  };

  const settlements: Promise<void>[] = requests.map((request, index) => {
    const acquirePromise: Promise<T> = Promise.resolve().then(() =>
      request.acquire(controllers[index]!.signal),
    );

    // 跟踪 acquire 的真实落定，无论多晚：迟到成功记录资源，迟到失败记录错误。
    const tracked: Promise<void> = acquirePromise.then(
      (value) => {
        resources[index] = value;
        hasResource[index] = true;
      },
      (error: unknown) => {
        recordError(index, error);
      },
    );

    if (options.timeoutMs == null) return tracked;

    const timed: Promise<void> = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        recordError(index, new AcquireTimeoutError(index, options.timeoutMs!));
        resolve();
      }, options.timeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      tracked.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });

    // 即使超时先触发，也要等 acquire 真正落定，才能释放迟到的成功。
    return timed.then(() => tracked);
  });

  await Promise.all(settlements);

  if (!hasError.some(Boolean)) {
    return resources as T[];
  }

  // 逆申请顺序释放，每个资源恰好一次；释放失败不中断其余释放。
  const releaseErrors: unknown[] = [];
  for (let index = count - 1; index >= 0; index--) {
    if (!hasResource[index]) continue;
    try {
      await requests[index]!.release(resources[index] as T);
    } catch (error) {
      releaseErrors.push(error);
    }
  }

  // 错误选择按申请序：抛出下标最小的失败原因。
  for (let index = 0; index < count; index++) {
    if (hasError[index]) {
      const selected = errors[index];
      if (
        releaseErrors.length > 0 &&
        typeof selected === 'object' &&
        selected !== null
      ) {
        try {
          (selected as { releaseErrors?: unknown[] }).releaseErrors = releaseErrors;
        } catch {
          // 错误对象不可扩展时忽略。
        }
      }
      throw selected;
    }
  }

  throw new Error('unreachable');
}
