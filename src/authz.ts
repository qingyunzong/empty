/**
 * 鉴权会话库：会话快照绑定策略版本。
 *
 * 核心语义：
 * 1. 会话打开时绑定当时的策略版本（快照），会话内所有读/权限判定只看该快照，
 *    长事务因此可以稳定地继续读旧权限。
 * 2. 事务提交时，必须用策略库的【最新版本】重核该事务记录的全部写动作。
 * 3. 重核有任何一条不通过：整个事务中止，所有写动作都不落库（全不提交）。
 */

export type Subject = string;
export type Permission = string;

/** 一份不可变的策略快照：subject -> 权限集合。 */
export class PolicySnapshot {
  readonly version: number;
  private readonly grants: ReadonlyMap<Subject, ReadonlySet<Permission>>;

  constructor(version: number, grants: ReadonlyMap<Subject, ReadonlySet<Permission>>) {
    this.version = version;
    const frozen = new Map<Subject, ReadonlySet<Permission>>();
    for (const [subject, perms] of grants) {
      frozen.set(subject, new Set(perms));
    }
    this.grants = frozen;
  }

  allows(subject: Subject, permission: Permission): boolean {
    return this.grants.get(subject)?.has(permission) ?? false;
  }

  permissionsOf(subject: Subject): ReadonlySet<Permission> {
    return this.grants.get(subject) ?? new Set();
  }
}

/** 版本化策略库：每次 publish 产生新的不可变版本，旧版本快照仍可读取。 */
export class PolicyStore {
  private readonly versions: PolicySnapshot[] = [];

  constructor(initialGrants: Record<Subject, readonly Permission[]>) {
    this.publish(initialGrants);
  }

  /** 发布新版本，返回版本号（从 1 开始递增）。 */
  publish(grants: Record<Subject, readonly Permission[]>): number {
    const map = new Map<Subject, ReadonlySet<Permission>>();
    for (const [subject, perms] of Object.entries(grants)) {
      map.set(subject, new Set(perms));
    }
    const snapshot = new PolicySnapshot(this.versions.length + 1, map);
    this.versions.push(snapshot);
    return snapshot.version;
  }

  latestVersion(): number {
    return this.versions.length;
  }

  latest(): PolicySnapshot {
    const snap = this.versions[this.versions.length - 1];
    if (!snap) throw new Error("PolicyStore 为空");
    return snap;
  }

  snapshot(version: number): PolicySnapshot {
    const snap = this.versions[version - 1];
    if (!snap) throw new RangeError(`策略版本不存在: ${version}`);
    return snap;
  }

  /** 打开会话：绑定当前最新版本快照。 */
  openSession(id: string): AuthSession {
    return new AuthSession(id, this, this.latest());
  }
}

/** 一条写动作意图：提交前只记录，不落库。 */
export interface WriteIntent {
  readonly seq: number;
  readonly subject: Subject;
  readonly permission: Permission;
  readonly key: string;
  readonly value: string;
}

export type Decision = "allow" | "deny";

/** 单条写动作的旧/新命中证据。 */
export interface WriteEvidence {
  readonly seq: number;
  readonly subject: Subject;
  readonly permission: Permission;
  readonly key: string;
  /** 会话快照（旧版本）下的判定。 */
  readonly sessionVersion: number;
  readonly sessionDecision: Decision;
  /** 提交时最新版本下的重核判定。 */
  readonly latestVersion: number;
  readonly latestDecision: Decision;
  readonly outcome: "committed" | "aborted";
}

export interface CommitResult {
  readonly status: "committed" | "aborted";
  readonly sessionVersion: number;
  readonly latestVersion: number;
  readonly evidence: readonly WriteEvidence[];
  /** 旧允许 -> 新拒绝 的撤销命中（重核拦截到的写动作）。 */
  readonly revocationHits: readonly WriteEvidence[];
  readonly appliedKeys: readonly string[];
}

export class AuthzError extends Error {
  constructor(
    message: string,
    readonly version: number,
    readonly subject: Subject,
    readonly permission: Permission,
  ) {
    super(message);
    this.name = "AuthzError";
  }
}

/** 极简 KV 数据存储：applyAll 在重核全部通过后一次性应用，保证原子性。 */
export class DataStore {
  private readonly data = new Map<string, string>();

  get(key: string): string | undefined {
    return this.data.get(key);
  }

  keys(): string[] {
    return [...this.data.keys()].sort();
  }

  /** 仅在全部写动作重核通过后调用；先验证后写入，因此天然全有或全无。 */
  applyAll(intents: readonly WriteIntent[]): void {
    for (const intent of intents) {
      this.data.set(intent.key, intent.value);
    }
  }
}

/** 鉴权会话：读与暂存写都基于绑定的快照版本。 */
export class AuthSession {
  constructor(
    readonly id: string,
    private readonly store: PolicyStore,
    /** 会话绑定的策略快照（旧版本在长事务期间持续可读）。 */
    readonly boundSnapshot: PolicySnapshot,
  ) {}

  get boundVersion(): number {
    return this.boundSnapshot.version;
  }

  /** 读权限判定：永远只看会话绑定的快照，不看最新版本。 */
  can(subject: Subject, permission: Permission): boolean {
    return this.boundSnapshot.allows(subject, permission);
  }

  assertCan(subject: Subject, permission: Permission): void {
    if (!this.can(subject, permission)) {
      throw new AuthzError(
        `[会话 ${this.id}@v${this.boundVersion}] 拒绝: ${subject} 无权限 ${permission}`,
        this.boundVersion,
        subject,
        permission,
      );
    }
  }

  begin(): Transaction {
    return new Transaction(this, this.store);
  }
}

/** 事务：暂存写动作，提交时按最新策略版本重核全部写动作。 */
export class Transaction {
  private readonly intents: WriteIntent[] = [];
  private seq = 0;
  private closed = false;

  constructor(
    readonly session: AuthSession,
    private readonly policies: PolicyStore,
  ) {}

  /**
   * 暂存一条写动作。暂存时按会话快照（旧版本）做预检并记录证据；
   * 真正的裁决发生在 commit 的重核阶段。
   */
  stageWrite(subject: Subject, permission: Permission, key: string, value: string): void {
    this.ensureOpen();
    this.session.assertCan(subject, permission);
    this.intents.push({ seq: ++this.seq, subject, permission, key, value });
  }

  /** 事务内读数据（读已提交的数据）。 */
  read(data: DataStore, key: string): string | undefined {
    this.ensureOpen();
    return data.get(key);
  }

  /**
   * 提交：用最新策略版本重核全部写动作。
   * 任一写动作在最新版本下被拒绝 -> 整个事务中止，什么都不落库。
   */
  commit(data: DataStore): CommitResult {
    this.ensureOpen();
    this.closed = true;

    const latest = this.policies.latest();
    const sessionVersion = this.session.boundVersion;

    const evidence: WriteEvidence[] = this.intents.map((intent) => ({
      seq: intent.seq,
      subject: intent.subject,
      permission: intent.permission,
      key: intent.key,
      sessionVersion,
      sessionDecision: "allow", // 能进入 intents 说明暂存时旧版本预检已通过
      latestVersion: latest.version,
      latestDecision: latest.allows(intent.subject, intent.permission) ? "allow" : "deny",
      outcome: "aborted", // 先按中止填，全部通过后统一改 committed
    }));

    const allAllowed = evidence.every((e) => e.latestDecision === "allow");

    if (allAllowed) {
      data.applyAll(this.intents);
      for (const e of evidence) (e as { outcome: string }).outcome = "committed";
    }

    const revocationHits = evidence.filter(
      (e) => e.sessionDecision === "allow" && e.latestDecision === "deny",
    );

    return {
      status: allAllowed ? "committed" : "aborted",
      sessionVersion,
      latestVersion: latest.version,
      evidence,
      revocationHits,
      appliedKeys: allAllowed ? this.intents.map((i) => i.key) : [],
    };
  }

  abort(): void {
    this.closed = true;
  }

  get pendingWrites(): readonly WriteIntent[] {
    return this.intents;
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("事务已关闭");
  }
}

/** 把提交证据格式化为可读文本（用于模拟输出与测试断言）。 */
export function formatEvidence(result: CommitResult): string {
  const lines: string[] = [];
  lines.push(
    `提交结果: ${result.status === "committed" ? "已提交" : "已中止（全不提交）"} ` +
      `(会话快照 v${result.sessionVersion} -> 提交时最新 v${result.latestVersion})`,
  );
  for (const e of result.evidence) {
    lines.push(
      `  写#${e.seq} ${e.subject} ${e.permission} ${e.key}: ` +
        `旧版本v${e.sessionVersion}=${e.sessionDecision} -> 新版本v${e.latestVersion}=${e.latestDecision} ` +
        `=> ${e.outcome === "committed" ? "已落库" : "已拦截"}`,
    );
  }
  if (result.revocationHits.length > 0) {
    lines.push(
      `  撤销命中 ${result.revocationHits.length} 条: ` +
        result.revocationHits.map((e) => `${e.subject}:${e.permission}@${e.key}`).join(", "),
    );
  }
  return lines.join("\n");
}
