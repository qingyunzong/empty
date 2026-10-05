/** 数据存储：只有提交重核全部通过后，写动作才会落到这里。 */

export interface Mutation {
  resource: string;
  value: string;
}

export class DataStore {
  private readonly data = new Map<string, string>();

  get(resource: string): string | undefined {
    return this.data.get(resource);
  }

  /** 原子应用：调用方必须保证整批写动作已通过最新版本重核。 */
  applyAll(mutations: readonly Mutation[]): void {
    for (const m of mutations) {
      this.data.set(m.resource, m.value);
    }
  }

  entries(): Record<string, string> {
    return Object.fromEntries(this.data);
  }
}
