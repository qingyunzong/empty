/**
 * 版本化策略库：每次授权/撤销产生一个不可变新版本，
 * 历史版本永久保留，供已绑定旧版本的会话快照继续判定。
 */

export type Action = "read" | "write";

export interface Permission {
  subject: string;
  action: Action;
  resource: string;
}

function keyOf(p: Permission): string {
  return `${p.subject}|${p.action}|${p.resource}`;
}

export class PolicyStore {
  /** version -> 该版本的权限集合（不可变快照） */
  private readonly versions = new Map<number, ReadonlySet<string>>();
  private currentVersion = 0;

  constructor() {
    this.versions.set(0, new Set());
  }

  get latestVersion(): number {
    return this.currentVersion;
  }

  hasVersion(version: number): boolean {
    return this.versions.has(version);
  }

  grant(permission: Permission): number {
    return this.mutate((next) => next.add(keyOf(permission)));
  }

  revoke(permission: Permission): number {
    return this.mutate((next) => next.delete(keyOf(permission)));
  }

  private mutate(fn: (next: Set<string>) => void): number {
    const next = new Set(this.versions.get(this.currentVersion));
    fn(next);
    this.currentVersion += 1;
    this.versions.set(this.currentVersion, next);
    return this.currentVersion;
  }

  /** 按指定版本判定；缺省用最新版本。 */
  allows(permission: Permission, version?: number): boolean {
    const v = version ?? this.currentVersion;
    const snapshot = this.versions.get(v);
    if (snapshot === undefined) {
      throw new RangeError(`unknown policy version v${v}`);
    }
    return snapshot.has(keyOf(permission));
  }
}
