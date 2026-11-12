import { base64UrlDecode, base64UrlEncode, sha256Hex } from './canonical.ts';
import { JoinEngineError } from './errors.ts';
import { reduceJoin } from './reduction.ts';
import type {
  JoinInput,
  JoinResultBatch,
  ReductionResult,
  Row,
} from './types.ts';

interface Frame {
  relation: string;
  index: number;
}

interface TokenPayload {
  version: 1;
  digest: string;
  stack: Frame[];
  started: boolean;
  emitted: number;
}

const encoder = new TextEncoder();

function encodeToken(payload: TokenPayload): string {
  const json = JSON.stringify(payload);
  const checksum = sha256Hex(json);
  return `${base64UrlEncode(encoder.encode(json))}.${checksum}`;
}

function decodeToken(token: string): { payload: TokenPayload; json: string } {
  const separator = token.lastIndexOf('.');
  if (separator <= 0) {
    throw new JoinEngineError('TOKEN_CORRUPT', 'snapshot token is malformed');
  }
  const encoded = token.slice(0, separator);
  const checksum = token.slice(separator + 1);
  let json: string;
  try {
    json = new TextDecoder().decode(base64UrlDecode(encoded));
  } catch {
    throw new JoinEngineError('TOKEN_CORRUPT', 'snapshot token payload cannot be decoded');
  }
  if (sha256Hex(json) !== checksum) {
    throw new JoinEngineError('TOKEN_CORRUPT', 'snapshot token checksum does not match its content');
  }
  let payload: TokenPayload;
  try {
    payload = JSON.parse(json) as TokenPayload;
  } catch {
    throw new JoinEngineError('TOKEN_CORRUPT', 'snapshot token is not valid JSON');
  }
  if (payload.version !== 1 || !Array.isArray(payload.stack)) {
    throw new JoinEngineError('TOKEN_CORRUPT', 'snapshot token has an unsupported shape');
  }
  return { payload, json };
}

export function mergeVector(
  result: ReductionResult,
  vector: readonly number[],
): Row {
  const merged: Record<string, bigint | string> = {};
  for (const [position, name] of result.plan.relations.entries()) {
    const row = result.reduced[name][vector[position]];
    for (const attribute of result.plan.attributes[name]) {
      merged[attribute] = row[attribute];
    }
  }
  return merged;
}

export class JoinIterator {
  private readonly result: ReductionResult;
  private readonly stack: Frame[] = [];
  private started = false;
  private done = false;
  private emitted = 0;

  constructor(result: ReductionResult) {
    this.result = result;
    if (result.isEmpty) {
      this.done = true;
    }
  }

  get digest(): string {
    return this.result.digest;
  }

  get isDone(): boolean {
    return this.done;
  }

  get totalEmitted(): number {
    return this.emitted;
  }

  private compatible(name: string, row: Row): boolean {
    const parent = this.result.plan.parent[name];
    if (parent === null) {
      return true;
    }
    const parentPosition = this.result.plan.relations.indexOf(parent);
    const parentIndex = this.stack[parentPosition].index;
    const parentRow = this.result.reduced[parent][parentIndex];
    for (const attribute of this.result.plan.attributes[name]) {
      if (attribute in parentRow && parentRow[attribute] !== row[attribute]) {
        return false;
      }
    }
    return true;
  }

  private snapshotToken(): string {
    return encodeToken({
      version: 1,
      digest: this.result.digest,
      stack: this.stack.map((frame) => ({ ...frame })),
      started: this.started,
      emitted: this.emitted,
    });
  }

  private restoreToken(token: string): void {
    const { payload } = decodeToken(token);
    if (payload.digest !== this.result.digest) {
      throw new JoinEngineError(
        'TOKEN_INPUT_MISMATCH',
        'snapshot token was created for a different immutable input or tree',
      );
    }
    this.stack.length = 0;
    for (const frame of payload.stack) {
      const relationRows = this.result.reduced[frame.relation];
      if (
        relationRows === undefined ||
        !Number.isInteger(frame.index) ||
        frame.index < 0 ||
        frame.index >= relationRows.length
      ) {
        throw new JoinEngineError('TOKEN_CORRUPT', 'snapshot token references an invalid cursor');
      }
      this.stack.push({ relation: frame.relation, index: frame.index });
    }
    this.started = payload.started;
    this.emitted = payload.emitted;
    this.done = false;
  }

  next(limit?: number, resumeToken?: string): JoinResultBatch {
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      throw new JoinEngineError('INVALID_LIMIT', 'limit must be a positive integer');
    }
    if (resumeToken !== undefined) {
      this.restoreToken(resumeToken);
    }

    const vectors: number[][] = [];
    const rows: Row[] = [];
    const capacity = limit ?? Number.POSITIVE_INFINITY;

    while (!this.done && vectors.length < capacity) {
      if (!this.started) {
        this.started = true;
        this.stack.push({ relation: this.result.plan.relations[0], index: -1 });
      }

      let emitted = false;
      while (!emitted && this.stack.length > 0) {
        const frame = this.stack[this.stack.length - 1];
        const candidates = this.result.reduced[frame.relation];
        frame.index += 1;

        if (frame.index >= candidates.length) {
          this.stack.pop();
          continue;
        }
        if (!this.compatible(frame.relation, candidates[frame.index])) {
          continue;
        }
        if (this.stack.length === this.result.plan.relations.length) {
          emitted = true;
          break;
        }
        this.stack.push({
          relation: this.result.plan.relations[this.stack.length],
          index: -1,
        });
      }

      if (this.stack.length === 0) {
        this.done = true;
        break;
      }

      const vector = this.stack.map((frame) => frame.index);
      vectors.push(vector);
      rows.push(mergeVector(this.result, vector));
      this.emitted += 1;
    }

    const batch: JoinResultBatch = {
      vectors,
      rows,
      done: this.done,
    };
    if (!this.done) {
      batch.token = this.snapshotToken();
    }
    return batch;
  }
}

export function createJoinIterator(input: JoinInput): {
  result: ReductionResult;
  iterator: JoinIterator;
} {
  const result = reduceJoin(input);
  return { result, iterator: new JoinIterator(result) };
}

export function resumeJoinIterator(
  input: JoinInput,
  token: string | undefined,
  limit?: number,
): JoinResultBatch {
  const { iterator } = createJoinIterator(input);
  return iterator.next(limit, token);
}
