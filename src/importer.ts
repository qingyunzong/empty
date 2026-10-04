import { createHash } from 'node:crypto';
import * as fs from 'node:fs';

/** 源文件在检查点偏移之前被修改（或截断）时抛出。 */
export class SourceModifiedError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(message);
    this.name = 'SourceModifiedError';
    this.offset = offset;
  }
}

/** 持久化到磁盘的检查点：字节偏移 + 前缀摘要 + 未完结记录的原始字节。 */
export interface Checkpoint {
  version: 1;
  /** 已消费的源文件字节数。 */
  offset: number;
  /** 尚未遇到换行符的半条记录（base64 编码的原始字节，可能是多字节字符的前半段）。 */
  pending: string;
  /** 已导入的记录总数。 */
  records: number;
  /** 源文件前缀 [0, offset) 的 SHA-256（hex）。 */
  digest: string;
}

export interface ImportOptions {
  /** 源文件路径。 */
  source: string;
  /** 检查点文件路径。 */
  checkpoint: string;
  /** 每多少条记录保存一次检查点，默认 16。 */
  batchSize?: number;
  /** 本次运行最多消费的字节数（用于暂停/断点模拟），默认不限。 */
  byteBudget?: number;
  /** 记录消费者，index 为全局记录序号。 */
  sink?: (record: string, index: number) => void;
}

export interface ImportResult {
  status: 'completed' | 'paused';
  /** 累计已导入记录数。 */
  records: number;
  /** 累计已消费字节偏移。 */
  offset: number;
}

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

function sha256Prefix(fd: number, length: number): string {
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(64 * 1024);
  let position = 0;
  while (position < length) {
    const want = Math.min(chunk.length, length - position);
    const got = fs.readSync(fd, chunk, 0, want, position);
    if (got <= 0) {
      throw new SourceModifiedError(
        `source shrank while hashing prefix: wanted ${length} bytes, got ${position}`,
        length,
      );
    }
    hash.update(chunk.subarray(0, got));
    position += got;
  }
  return hash.digest('hex');
}

function saveCheckpoint(path: string, checkpoint: Checkpoint): void {
  const tmp = `${path}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(checkpoint, null, 2));
  fs.renameSync(tmp, path);
}

function loadCheckpoint(path: string): Checkpoint | null {
  if (!fs.existsSync(path)) return null;
  const raw: unknown = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`invalid checkpoint file: ${path}`);
  }
  const c = raw as Checkpoint;
  if (
    c.version !== 1 ||
    typeof c.offset !== 'number' ||
    typeof c.pending !== 'string' ||
    typeof c.records !== 'number' ||
    typeof c.digest !== 'string'
  ) {
    throw new Error(`invalid checkpoint file: ${path}`);
  }
  return c;
}

/**
 * 导入源文件（换行分隔的 UTF-8 记录），可按批次持久化检查点并断点续传。
 *
 * 恢复时先核对源文件：前缀 [0, offset) 的 SHA-256 必须与检查点一致。
 * - 源尾追加（前缀不变、文件变长）：从 offset 继续导入；
 * - 中段修改 / 截断（摘要不符或文件短于 offset）：抛出 SourceModifiedError。
 *
 * 半条记录（含跨检查点的多字节字符）以原始字节存入检查点 pending，
 * 恢复后拼回继续扫描，保证每条记录恰好导入一次。
 */
export function importFile(options: ImportOptions): ImportResult {
  const { source, checkpoint } = options;
  const batchSize = options.batchSize ?? 16;
  const byteBudget = options.byteBudget ?? Number.POSITIVE_INFINITY;
  const sink = options.sink ?? ((): void => {});
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError('batchSize must be a positive integer');
  }

  const fd = fs.openSync(source, 'r');
  try {
    const size = fs.fstatSync(fd).size;

    let offset = 0;
    let records = 0;
    let pendingBytes: number[] = [];

    const prior = loadCheckpoint(checkpoint);
    if (prior !== null) {
      if (size < prior.offset) {
        throw new SourceModifiedError(
          `source truncated: checkpoint offset ${prior.offset} exceeds size ${size}`,
          prior.offset,
        );
      }
      const digest = sha256Prefix(fd, prior.offset);
      if (digest !== prior.digest) {
        throw new SourceModifiedError(
          `source modified before checkpoint offset ${prior.offset}`,
          prior.offset,
        );
      }
      offset = prior.offset;
      records = prior.records;
      pendingBytes = [...Buffer.from(prior.pending, 'base64')];
    }

    let sinceCheckpoint = 0;
    const persist = (): void => {
      saveCheckpoint(checkpoint, {
        version: 1,
        offset,
        pending: Buffer.from(pendingBytes).toString('base64'),
        records,
        digest: sha256Prefix(fd, offset),
      });
      sinceCheckpoint = 0;
    };

    const emit = (lineBytes: number[]): void => {
      let end = lineBytes.length;
      if (end > 0 && lineBytes[end - 1] === CARRIAGE_RETURN) end -= 1;
      sink(Buffer.from(lineBytes.slice(0, end)).toString('utf8'), records);
      records += 1;
      sinceCheckpoint += 1;
      if (sinceCheckpoint >= batchSize) persist();
    };

    const readBuf = Buffer.alloc(8192);
    let consumed = 0;
    let paused = false;

    outer: while (offset < size) {
      const want = Math.min(readBuf.length, size - offset);
      const got = fs.readSync(fd, readBuf, 0, want, offset);
      if (got <= 0) break;
      for (let i = 0; i < got; i += 1) {
        const byte = readBuf[i]!;
        offset += 1;
        consumed += 1;
        if (byte === NEWLINE) {
          emit(pendingBytes);
          pendingBytes = [];
        } else {
          pendingBytes.push(byte);
        }
        if (consumed >= byteBudget && offset < size) {
          paused = true;
          break outer;
        }
      }
    }

    if (!paused && pendingBytes.length > 0) {
      emit(pendingBytes); // 文件末尾无换行符的最后一条记录
      pendingBytes = [];
    }
    persist();

    return { status: paused ? 'paused' : 'completed', records, offset };
  } finally {
    fs.closeSync(fd);
  }
}
