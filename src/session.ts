import { EvidenceLog } from "./evidence.js";
import { PolicyStore } from "./policy.js";
import { DataStore, Mutation } from "./store.js";

export class AuthorizationError extends Error {
  constructor(
    message: string,
    readonly checkedVersion: number,
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export interface StagedWrite {
  resource: string;
  mutation: Mutation;
  /** 入缓冲时乐观判定所用的快照版本 */
  stagedAtVersion: number;
}

export interface CommitFailure {
  resource: string;
  reason: string;
}

export type CommitResult =
  | { status: "committed"; recheckedVersion: number; applied: Mutation[] }
  | { status: "aborted"; recheckedVersion: number; failures: CommitFailure[] };

/**
 * 会话：创建时绑定策略版本快照。
 * 会话内所有读/写缓冲判定都使用该绑定版本，
 * 即使策略库已推进到更新的版本。
 */
export class Session {
  constructor(
    readonly subject: string,
    readonly boundVersion: number,
    private readonly policy: PolicyStore,
    private readonly store: DataStore,
    private readonly log: EvidenceLog,
  ) {}

  beginTransaction(): Transaction {
    return new Transaction(this, this.policy, this.store, this.log);
  }
}

export class Transaction {
  private readonly staged: StagedWrite[] = [];
  private closed = false;

  constructor(
    private readonly session: Session,
    private readonly policy: PolicyStore,
    private readonly store: DataStore,
    private readonly log: EvidenceLog,
  ) {}

  /** 长事务读：按会话绑定的（可能已过期的）快照版本判定。 */
  read(resource: string): string | undefined {
    this.assertOpen();
    const allowed = this.policy.allows(
      { subject: this.session.subject, action: "read", resource },
      this.session.boundVersion,
    );
    this.log.record({
      phase: "read",
      subject: this.session.subject,
      action: "read",
      resource,
      checkedVersion: this.session.boundVersion,
      latestVersion: this.policy.latestVersion,
      decision: allowed ? "allow" : "deny",
      note: allowed ? "快照放行" : "快照拒绝",
    });
    if (!allowed) {
      throw new AuthorizationError(
        `read ${resource} denied at snapshot v${this.session.boundVersion}`,
        this.session.boundVersion,
      );
    }
    return this.store.get(resource);
  }

  /** 写动作入缓冲：按快照版本乐观判定，真正生效推迟到提交重核。 */
  write(resource: string, value: string): void {
    this.assertOpen();
    const allowed = this.policy.allows(
      { subject: this.session.subject, action: "write", resource },
      this.session.boundVersion,
    );
    this.log.record({
      phase: "write-stage",
      subject: this.session.subject,
      action: "write",
      resource,
      checkedVersion: this.session.boundVersion,
      latestVersion: this.policy.latestVersion,
      decision: allowed ? "allow" : "deny",
      note: allowed ? "快照放行，进入缓冲" : "快照拒绝",
    });
    if (!allowed) {
      throw new AuthorizationError(
        `write ${resource} denied at snapshot v${this.session.boundVersion}`,
        this.session.boundVersion,
      );
    }
    this.staged.push({
      resource,
      mutation: { resource, value },
      stagedAtVersion: this.session.boundVersion,
    });
  }

  /**
   * 提交：用【最新】策略版本重核全部缓冲写动作。
   * 任一失败则整体中止，一个写都不落库。
   */
  commit(): CommitResult {
    this.assertOpen();
    this.closed = true;
    const recheckedVersion = this.policy.latestVersion;
    const failures: CommitFailure[] = [];

    for (const s of this.staged) {
      const allowed = this.policy.allows(
        { subject: this.session.subject, action: "write", resource: s.resource },
        recheckedVersion,
      );
      this.log.record({
        phase: "commit-recheck",
        subject: this.session.subject,
        action: "write",
        resource: s.resource,
        checkedVersion: recheckedVersion,
        latestVersion: recheckedVersion,
        decision: allowed ? "allow" : "deny",
        note: allowed
          ? `重核通过 (缓冲时 v${s.stagedAtVersion})`
          : `重核拒绝：权限已在 v${recheckedVersion} 撤销 (缓冲时 v${s.stagedAtVersion} 放行)`,
      });
      if (!allowed) {
        failures.push({
          resource: s.resource,
          reason: `write permission revoked before commit (rechecked at v${recheckedVersion})`,
        });
      }
    }

    if (failures.length > 0) {
      // 失败全不提交：不落任何一条缓冲写。
      return { status: "aborted", recheckedVersion, failures };
    }

    const applied = this.staged.map((s) => s.mutation);
    this.store.applyAll(applied);
    return { status: "committed", recheckedVersion, applied };
  }

  /** 放弃事务：缓冲写全部丢弃。 */
  rollback(): void {
    this.closed = true;
    this.staged.length = 0;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("transaction already closed");
    }
  }
}

/** 打开一个会话：绑定当前最新策略版本作为快照。 */
export function openSession(
  subject: string,
  policy: PolicyStore,
  store: DataStore,
  log: EvidenceLog,
): Session {
  return new Session(subject, policy.latestVersion, policy, store, log);
}
