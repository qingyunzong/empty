import type { Problem } from "./model.js";
import type { Plan } from "./planner.js";

export type Action = "download" | "apply" | "delete";

export interface CertStep {
  index: number;
  action: Action;
  packageId: string;
  versionAfter: string;
  storedBytes: number;
  peakBytes: number;
  note: string;
}

export interface Certificate {
  steps: CertStep[];
  totalBytes: number;
  peakBytes: number;
  limitBytes: number;
  finalVersion: string;
  target: string;
  storedAtEnd: number;
  ok: boolean;
  problems: string[];
}

export function buildCertificate(problem: Problem, plan: Plan): Certificate {
  const steps: CertStep[] = [];
  const problems: string[] = [];
  let stored = 0;
  let peak = 0;
  let version = problem.source;
  let index = 0;
  for (const p of plan.packages) {
    if (p.from !== version) {
      problems.push(`包 ${p.id} 的起点 ${p.from} 与当前版本 ${version} 不符`);
    }
    stored += p.bytes;
    peak = Math.max(peak, stored);
    if (stored > problem.spaceLimitBytes) {
      problems.push(`下载 ${p.id} 后暂存 ${stored} B 超过上限 ${problem.spaceLimitBytes} B`);
    }
    steps.push({
      index: ++index,
      action: "download",
      packageId: p.id,
      versionAfter: version,
      storedBytes: stored,
      peakBytes: peak,
      note: `+${p.bytes} B 暂存`,
    });
    const from = version;
    version = p.to;
    steps.push({
      index: ++index,
      action: "apply",
      packageId: p.id,
      versionAfter: version,
      storedBytes: stored,
      peakBytes: peak,
      note: `应用 ${from} -> ${p.to}，包已消费`,
    });
    stored -= p.bytes;
    steps.push({
      index: ++index,
      action: "delete",
      packageId: p.id,
      versionAfter: version,
      storedBytes: stored,
      peakBytes: peak,
      note: `删除已消费包，释放 ${p.bytes} B`,
    });
  }
  if (version !== problem.target) {
    problems.push(`结束版本 ${version} 不等于目标版本 ${problem.target}`);
  }
  if (stored !== 0) {
    problems.push(`结束时仍有 ${stored} B 未清理`);
  }
  return {
    steps,
    totalBytes: plan.totalBytes,
    peakBytes: peak,
    limitBytes: problem.spaceLimitBytes,
    finalVersion: version,
    target: problem.target,
    storedAtEnd: stored,
    ok: problems.length === 0,
    problems,
  };
}
