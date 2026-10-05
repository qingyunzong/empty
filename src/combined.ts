export interface ResourceRequest<R> {
  acquire: (signal: AbortSignal) => R | Promise<R>;
  release: (resource: R) => void | Promise<void>;
  timeoutMs?: number;
}

export class TimeoutError extends Error {
  readonly index: number;
  readonly timeoutMs: number;
  constructor(index: number, timeoutMs: number) {
    super(`request #${index} timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.index = index;
    this.timeoutMs = timeoutMs;
  }
}

type ResultsOf<Reqs extends readonly ResourceRequest<any>[]> = {
  [K in keyof Reqs]: Reqs[K] extends ResourceRequest<infer R> ? Awaited<R> : never;
};

/**
 * 并发申请全部资源：
 * - 任一请求失败或超时，立即通过 AbortSignal 取消其余请求；
 * - 已成功的资源按逆申请顺序逐个释放，且每个资源至多释放一次；
 * - 取消/超时后的迟到成功同样被释放，且不改变最终返回的错误；
 * - 多个失败并存时，返回申请序最靠前的错误（超时记为 TimeoutError）。
 *
 * 注意：未设置 timeoutMs 且永不 settle 的 acquire 会让本函数一直等待。
 */
export async function acquireAll<Reqs extends readonly ResourceRequest<any>[]>(
  requests: [...Reqs],
): Promise<ResultsOf<Reqs>> {
  const n = requests.length;
  if (n === 0) return [] as unknown as ResultsOf<Reqs>;

  return new Promise<ResultsOf<Reqs>>((resolve, reject) => {
    const controller = new AbortController();
    const results: unknown[] = new Array(n);
    const acquired = new Array<boolean>(n).fill(false);
    const errors = new Map<number, unknown>();
    let settledCount = 0;

    const finish = async () => {
      if (errors.size === 0) {
        resolve(results as ResultsOf<Reqs>);
        return;
      }
      for (let i = n - 1; i >= 0; i--) {
        if (!acquired[i]) continue;
        acquired[i] = false;
        try {
          await requests[i]!.release(results[i]);
        } catch {
          // 释放失败不得掩盖原始错误
        }
      }
      let first = Number.POSITIVE_INFINITY;
      for (const idx of errors.keys()) {
        if (idx < first) first = idx;
      }
      reject(errors.get(first));
    };

    const onSettled = () => {
      settledCount += 1;
      if (settledCount === n) void finish();
    };

    requests.forEach((req, index) => {
      let done = false;
      const pending = Promise.resolve().then(() => req.acquire(controller.signal));

      const timer =
        req.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              if (done) return;
              done = true;
              errors.set(index, new TimeoutError(index, req.timeoutMs!));
              controller.abort();
              onSettled();
              // 迟到结果：成功必须释放，失败忽略；均不改变已确定的错误
              pending.then(
                (resource) => {
                  void Promise.resolve(req.release(resource)).catch(() => {});
                },
                () => {},
              );
            }, req.timeoutMs);

      pending.then(
        (resource) => {
          if (done) return;
          done = true;
          if (timer !== undefined) clearTimeout(timer);
          acquired[index] = true;
          results[index] = resource;
          onSettled();
        },
        (err: unknown) => {
          if (done) return;
          done = true;
          if (timer !== undefined) clearTimeout(timer);
          errors.set(index, err);
          controller.abort();
          onSettled();
        },
      );
    });
  });
}
