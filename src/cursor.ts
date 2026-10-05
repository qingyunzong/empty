import { Buffer } from "node:buffer";

/** 解析游标。结构（struct/array）解析失败时 offset 会被恢复到该结构起点。 */
export class Cursor {
  offset: number;
  constructor(readonly buf: Buffer, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > buf.length) {
      throw new RangeError(`invalid start offset ${offset} for buffer of length ${buf.length}`);
    }
    this.offset = offset;
  }
}
