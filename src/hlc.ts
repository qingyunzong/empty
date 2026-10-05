/** 混合逻辑时钟（时间戳 + 副本 ID 决胜），用于乱序操作的确定性排序。 */
export interface Hlc {
  time: number;
  replica: string;
}

export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.time !== b.time) return a.time < b.time ? -1 : 1;
  if (a.replica === b.replica) return 0;
  return a.replica < b.replica ? -1 : 1;
}
