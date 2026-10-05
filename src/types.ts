// 核验库输入的三类证据文档的数据模型
export interface ManifestItem {
  itemId: string;
  runId: string;
  problemSummary: string;
  stageSources: string[];
}

export interface Manifest {
  items: ManifestItem[];
}

export interface TrajectoryStage {
  name: string;
  source: string;
}

export interface TrajectoryRun {
  runId: string;
  itemId: string;
  problemSummary: string;
  stages: TrajectoryStage[];
}

export interface Trajectories {
  runs: TrajectoryRun[];
}

export interface FileEntry {
  path: string;
  sha256: string;
  bytes: number;
}

export interface FileSummaryRun {
  runId: string;
  itemId: string;
  problemSummary: string;
  files: FileEntry[];
}

export interface FileSummaries {
  runs: FileSummaryRun[];
}
