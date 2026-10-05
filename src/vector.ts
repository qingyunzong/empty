/** 版本向量：记录本副本已应用各副本操作的最大序号。 */
export type Vector = Map<string, number>;

export function covers(vector: Vector, replica: string, seq: number): boolean {
  return (vector.get(replica) ?? 0) >= seq;
}

export function mergeVectorInto(target: Vector, source: Vector): void {
  for (const [replica, seq] of source) {
    target.set(replica, Math.max(target.get(replica) ?? 0, seq));
  }
}
