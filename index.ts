export type FrameId = string;

export interface ElementNode {
  readonly tag: string;
  readonly kind?: string;
  readonly childFrameId?: FrameId;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly children?: readonly ElementNode[];
}

export interface FrameSnapshot {
  readonly frameId: FrameId;
  readonly generation: number;
  readonly root: ElementNode;
}

export interface FrameAdapter {
  readFrame(frameId: FrameId): Promise<FrameSnapshot>;
  checkVersions(versions: ReadonlyMap<FrameId, number>): Promise<boolean>;
  subscribe(
    frameId: FrameId,
    fromGeneration: number,
    onChange: (generation: number) => void,
  ): Promise<() => void>;
}

export type SelectorEvaluator = (
  root: ElementNode,
  selector: string,
) => readonly ElementNode[] | Promise<readonly ElementNode[]>;

export type LocateErrorCode =
  | 'INVALID_QUERY'
  | 'NO_MATCH'
  | 'MULTIPLE_MATCHES'
  | 'NOT_IFRAME'
  | 'CYCLE'
  | 'FRAME_INACCESSIBLE'
  | 'VERSION_CONFLICT'
  | 'CANCELLED';

export class LocateError extends Error {
  readonly code: LocateErrorCode;
  readonly segmentIndex: number | null;

  constructor(code: LocateErrorCode, segmentIndex: number | null, message: string) {
    super(message);
    this.name = 'LocateError';
    this.code = code;
    this.segmentIndex = segmentIndex;
  }
}

export interface LocateOptions {
  readonly maxAttempts: number;
  readonly signal?: AbortSignal;
}

class AttemptInvalidated extends Error {}

export async function locate(
  adapter: FrameAdapter,
  evaluator: SelectorEvaluator,
  rootFrameId: FrameId,
  path: readonly string[],
  options: LocateOptions,
): Promise<readonly ElementNode[]> {
  const { maxAttempts, signal } = options;
  if (
    !Array.isArray(path) ||
    path.length === 0 ||
    path.some((segment) => typeof segment !== 'string' || segment.length === 0)
  ) {
    throw new LocateError('INVALID_QUERY', null, 'path must be a non-empty list of non-empty selectors');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new LocateError('INVALID_QUERY', null, 'maxAttempts must be a positive integer');
  }
  if (signal?.aborted) {
    throw new LocateError('CANCELLED', null, 'operation cancelled');
  }

  let cleanupCurrentAttempt: () => void = () => {};
  const onAbort = () => {
    cleanupCurrentAttempt();
  };
  signal?.addEventListener('abort', onAbort);
  const abortPromise = new Promise<never>((_resolve, reject) => {
    signal?.addEventListener(
      'abort',
      () => reject(new LocateError('CANCELLED', null, 'operation cancelled')),
      { once: true },
    );
  });
  abortPromise.catch(() => {});

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const unsubscribes: Array<() => void> = [];
      cleanupCurrentAttempt = () => {
        for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
      };
      try {
        const result = await Promise.race([
          runAttempt(adapter, evaluator, rootFrameId, path, signal, unsubscribes),
          abortPromise,
        ]);
        cleanupCurrentAttempt();
        return result;
      } catch (error) {
        cleanupCurrentAttempt();
        if (error instanceof AttemptInvalidated) {
          if (attempt === maxAttempts) {
            throw new LocateError(
              'VERSION_CONFLICT',
              null,
              `frame generations kept changing across ${maxAttempts} attempt(s)`,
            );
          }
          continue;
        }
        throw error;
      }
    }
    throw new LocateError('VERSION_CONFLICT', null, 'no attempt succeeded');
  } finally {
    signal?.removeEventListener('abort', onAbort);
    cleanupCurrentAttempt();
  }
}

async function runAttempt(
  adapter: FrameAdapter,
  evaluator: SelectorEvaluator,
  rootFrameId: FrameId,
  path: readonly string[],
  signal: AbortSignal | undefined,
  unsubscribes: Array<() => void>,
): Promise<readonly ElementNode[]> {
  const versions = new Map<FrameId, number>();
  const frameChain: FrameId[] = [];
  let invalidated = false;
  let frameId = rootFrameId;

  const checkpoint = () => {
    if (signal?.aborted) {
      throw new LocateError('CANCELLED', null, 'operation cancelled');
    }
    if (invalidated) {
      throw new AttemptInvalidated();
    }
  };

  for (let index = 0; index < path.length; index++) {
    let snapshot: FrameSnapshot;
    try {
      snapshot = await adapter.readFrame(frameId);
    } catch (error) {
      checkpoint();
      throw new LocateError(
        'FRAME_INACCESSIBLE',
        index,
        `frame "${frameId}" is inaccessible at segment ${index}`,
      );
    }
    checkpoint();
    versions.set(frameId, snapshot.generation);
    frameChain.push(frameId);

    const unsubscribe = await adapter.subscribe(frameId, snapshot.generation, () => {
      invalidated = true;
    });
    if (invalidated) {
      unsubscribe();
      throw new AttemptInvalidated();
    }
    unsubscribes.push(unsubscribe);
    checkpoint();

    const matches = await evaluator(snapshot.root, path[index]);
    checkpoint();

    if (index === path.length - 1) {
      const consistent = await adapter.checkVersions(versions);
      checkpoint();
      if (!consistent) {
        throw new AttemptInvalidated();
      }
      return matches;
    }

    if (matches.length === 0) {
      throw new LocateError('NO_MATCH', index, `selector "${path[index]}" matched nothing at segment ${index}`);
    }
    if (matches.length > 1) {
      throw new LocateError(
        'MULTIPLE_MATCHES',
        index,
        `selector "${path[index]}" matched ${matches.length} nodes at segment ${index}`,
      );
    }
    const hop = matches[0];
    if (hop.kind !== 'iframe' || typeof hop.childFrameId !== 'string') {
      throw new LocateError(
        'NOT_IFRAME',
        index,
        `selector "${path[index]}" matched a non-iframe node at segment ${index}`,
      );
    }
    if (frameChain.includes(hop.childFrameId)) {
      throw new LocateError(
        'CYCLE',
        index,
        `frame "${hop.childFrameId}" already appears in the descent chain at segment ${index}`,
      );
    }
    frameId = hop.childFrameId;
  }
  throw new AttemptInvalidated();
}
