/** 命中证据：每一次鉴权判定都留下一条可追溯记录。 */

export type Phase =
  | "read" // 长事务内读：按会话绑定的快照版本判定
  | "write-stage" // 写动作入缓冲：按快照版本做乐观判定
  | "commit-recheck"; // 提交时：按最新策略版本重核全部写动作

export type Decision = "allow" | "deny";

export interface Evidence {
  seq: number;
  phase: Phase;
  subject: string;
  action: string;
  resource: string;
  /** 本次判定实际使用的策略版本 */
  checkedVersion: number;
  /** 判定发生时的最新策略版本 */
  latestVersion: number;
  decision: Decision;
  note: string;
}

export class EvidenceLog {
  private entries: Evidence[] = [];

  record(entry: Omit<Evidence, "seq">): Evidence {
    const full: Evidence = { seq: this.entries.length + 1, ...entry };
    this.entries.push(full);
    return full;
  }

  all(): readonly Evidence[] {
    return this.entries;
  }

  /** 旧版本命中：判定用了落后于最新版本的快照且放行 */
  staleHits(): Evidence[] {
    return this.entries.filter(
      (e) => e.checkedVersion < e.latestVersion && e.decision === "allow",
    );
  }

  /** 新版本命中/拦截：提交重核阶段的判定 */
  rechecks(): Evidence[] {
    return this.entries.filter((e) => e.phase === "commit-recheck");
  }

  render(): string {
    const lines = this.entries.map((e) => {
      const stale = e.checkedVersion < e.latestVersion ? " [旧快照]" : "";
      return (
        `#${String(e.seq).padStart(2)} ${e.phase.padEnd(14)} ` +
        `${e.subject} ${e.action} ${e.resource} -> ${e.decision.toUpperCase()} ` +
        `(判定版本 v${e.checkedVersion}, 最新 v${e.latestVersion})${stale} ${e.note}`
      );
    });
    return lines.join("\n");
  }
}
