/** 一个差量包 = 一条有向版本边。 */
export interface DeltaPackage {
  /** 包 ID，全局唯一；并列时按 ID 序列字典序比较（UTF-16 码元序）。 */
  id: string;
  /** 起始版本节点。 */
  from: string;
  /** 目标版本节点。 */
  to: string;
  /** 下载字节费（正整数）。 */
  bytes: number;
  /** 应用期间除包文件本身外的峰值暂存字节（非负整数）。 */
  peak: number;
}

/** 规划问题输入。 */
export interface Problem {
  start: string;
  target: string;
  /** 磁盘空间上限（字节），任一时刻占用不得超过。 */
  spaceLimit: number;
  packages: DeltaPackage[];
}

/** 输入允许的最大包数量（保证枚举对照可行）。 */
export const MAX_PACKAGES = 18;

/** 证书中的一步：下载 -> 应用（达峰值）-> 清理已消费包。 */
export interface CertStep {
  /** 1 起始的步号。 */
  index: number;
  id: string;
  from: string;
  to: string;
  /** 本步下载量（字节）。 */
  downloadBytes: number;
  /** 下载完成后磁盘占用。 */
  storedAfterDownload: number;
  /** 应用期间额外暂存。 */
  tempBytes: number;
  /** 应用期间峰值占用 = storedAfterDownload + tempBytes。 */
  peakDuringApply: number;
  /** 清理（删除已消费包）后的磁盘占用。 */
  storedAfterCleanup: number;
  /** 本步各时刻占用是否均不超过空间上限。 */
  withinLimit: boolean;
}

/** 求解结果。 */
export interface SolveResult {
  ok: boolean;
  /** 无可行方案时的原因。 */
  reason?: string;
  /** 选中的包 ID 序列（按应用顺序）。 */
  sequence: string[];
  /** 总下载量（字节）。 */
  totalBytes: number;
  /** 逐步空间证书。 */
  steps: CertStep[];
  /** 全程峰值占用。 */
  maxPeak: number;
  /** 因空间限制被排除的边。 */
  excluded: { id: string; need: number }[];
}
