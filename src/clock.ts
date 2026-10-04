/** 可手动推进的逻辑时钟，测试用它精确控制租约过期，避免真实 sleep。 */
export class ManualClock {
  private t = 0;

  now = (): number => this.t;

  advance(ms: number): number {
    if (ms < 0) throw new Error("clock cannot go backwards");
    this.t += ms;
    return this.t;
  }
}
