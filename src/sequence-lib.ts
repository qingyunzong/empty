/**
 * 序列库：支持末尾追加（append）与撤销（undo），
 * 并可计算严格递增最长子序列（LIS）的索引证书。
 *
 * 并列打破规则：在所有最长严格递增子序列中，返回索引序列
 * 按字典序最小的那一个（等长按索引序最小），而不是值最小的那一个。
 */

export interface LisCertificate {
  /** 最优长度（子序列元素个数）。 */
  readonly length: number;
  /** 选中的下标，严格递增。 */
  readonly indices: number[];
  /** 选中下标对应的值，严格递增。 */
  readonly values: number[];
}

export class SequenceLibrary {
  private readonly items: number[] = [];

  get size(): number {
    return this.items.length;
  }

  /** 末尾追加一个值。 */
  append(value: number): void {
    if (typeof value !== "number" || Number.isNaN(value)) {
      throw new TypeError(`append 需要有限数值，收到: ${String(value)}`);
    }
    this.items.push(value);
  }

  /** 撤销最近一次 append；空序列上调用抛错。 */
  undo(): number {
    const removed = this.items.pop();
    if (removed === undefined) {
      throw new RangeError("空序列上无法 undo");
    }
    return removed;
  }

  /** 当前序列的副本。 */
  snapshot(): number[] {
    return [...this.items];
  }

  /**
   * 计算严格递增最长子序列的索引证书。
   *
   * 算法：
   * 1. startLen[i] 表示从下标 i 开始的严格递增子序列的最大长度（O(n^2) DP）。
   * 2. 贪心构造：第 k 个位置选择满足
   *    i > 上一选中下标、value[i] > 上一选中值、startLen[i] >= 剩余个数
   *    的最小下标 i。这保证结果在所有最优解中索引字典序最小，
   *    而不是值字典序最小。
   */
  lisCertificate(): LisCertificate {
    const seq = this.items;
    const n = seq.length;
    const startLen = new Array<number>(n).fill(1);
    let best = 0;
    for (let i = n - 1; i >= 0; i--) {
      let len = 1;
      for (let j = i + 1; j < n; j++) {
        if (seq[j] > seq[i] && startLen[j] + 1 > len) {
          len = startLen[j] + 1;
        }
      }
      startLen[i] = len;
      if (len > best) best = len;
    }

    const indices: number[] = [];
    const values: number[] = [];
    let prevIndex = -1;
    let prevValue = -Infinity;
    for (let remaining = best; remaining >= 1; remaining--) {
      for (let i = prevIndex + 1; i < n; i++) {
        if (seq[i] > prevValue && startLen[i] >= remaining) {
          indices.push(i);
          values.push(seq[i]);
          prevIndex = i;
          prevValue = seq[i];
          break;
        }
      }
    }
    return { length: best, indices, values };
  }

  /**
   * 校验一份索引证书：下标合法且严格递增、值与序列一致且严格递增、
   * 长度等于当前序列的最优长度。
   */
  verifyCertificate(cert: LisCertificate): boolean {
    const seq = this.items;
    if (cert.indices.length !== cert.length || cert.values.length !== cert.length) {
      return false;
    }
    for (let k = 0; k < cert.length; k++) {
      const idx = cert.indices[k];
      if (!Number.isInteger(idx) || idx < 0 || idx >= seq.length) return false;
      if (k > 0 && idx <= cert.indices[k - 1]) return false;
      if (cert.values[k] !== seq[idx]) return false;
      if (k > 0 && !(cert.values[k] > cert.values[k - 1])) return false;
    }
    return cert.length === this.lisCertificate().length;
  }
}
