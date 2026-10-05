// 核心核验逻辑：逐项比对 运行ID / 题面摘要 / 阶段来源
// 规则：任一来源缺失证据 -> 未知；来源间取值矛盾 -> 冲突（输出最小冲突对及引用范围）
import type { JsonDocument, Range } from './jsonpos.js';
import { asFileSummaries, asManifest, asTrajectories } from './loader.js';
import type { FileSummaryRun, ManifestItem, TrajectoryRun } from './types.js';

export type SourceName = 'manifest' | 'trajectory' | 'fileSummary';

export const SOURCE_LABELS: Record<SourceName, string> = {
  manifest: '清单',
  trajectory: '轨迹',
  fileSummary: '文件摘要',
};

export type CheckField = 'runId' | 'problemSummary' | 'stageSources';

export const FIELD_LABELS: Record<CheckField, string> = {
  runId: '运行ID',
  problemSummary: '题面摘要',
  stageSources: '阶段来源',
};

export type CheckStatus = 'consistent' | 'unknown' | 'conflict';

export const STATUS_LABELS: Record<CheckStatus, string> = {
  consistent: '一致',
  unknown: '未知',
  conflict: '冲突',
};

export interface Citation {
  file: string;
  pointer: string;
  range: Range;
}

export interface Evidence {
  source: SourceName;
  /** 用于展示的原始取值 */
  value: string;
  /** 归一化后的比较键 */
  key: string;
  citation: Citation;
}

export interface MissingEvidence {
  source: SourceName;
  file: string;
  reason: string;
}

export interface ConflictPair {
  a: Evidence;
  b: Evidence;
}

export interface FieldCheck {
  itemId: string;
  runId: string;
  field: CheckField;
  status: CheckStatus;
  evidence: Evidence[];
  missing: MissingEvidence[];
  conflictPairs: ConflictPair[];
}

export interface OrphanRun {
  runId: string;
  source: SourceName;
  status: 'unknown';
  reason: string;
  citation: Citation;
}

export interface VerifySummary {
  total: number;
  consistent: number;
  unknown: number;
  conflict: number;
  orphans: number;
}

export interface VerifyReport {
  checks: FieldCheck[];
  orphans: OrphanRun[];
  summary: VerifySummary;
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function cite(doc: JsonDocument, pointer: string): Citation {
  const range = doc.ranges.get(pointer);
  if (!range) throw new Error(`${doc.name}: 缺少指针 ${pointer} 的引用范围`);
  return { file: doc.name, pointer, range };
}

/**
 * 单字段判定：证据齐备且取值一致 -> 一致；有缺失 -> 未知；取值分多组 -> 冲突。
 * 最小冲突对：每个取值组取一个代表，两两组合，恰好覆盖所有分歧且不可再减。
 */
export function evaluateField(
  itemId: string,
  runId: string,
  field: CheckField,
  entries: Array<Evidence | null>,
  missing: MissingEvidence[],
): FieldCheck {
  const evidence = entries.filter((e): e is Evidence => e !== null);
  if (missing.length > 0 || evidence.length !== entries.length) {
    return { itemId, runId, field, status: 'unknown', evidence, missing, conflictPairs: [] };
  }
  const groups = new Map<string, Evidence[]>();
  for (const e of evidence) {
    const g = groups.get(e.key);
    if (g) g.push(e);
    else groups.set(e.key, [e]);
  }
  if (groups.size <= 1) {
    return { itemId, runId, field, status: 'consistent', evidence, missing: [], conflictPairs: [] };
  }
  const grouped = [...groups.values()];
  const conflictPairs: ConflictPair[] = [];
  for (let x = 0; x < grouped.length; x++) {
    for (let y = x + 1; y < grouped.length; y++) {
      conflictPairs.push({ a: (grouped[x] as Evidence[])[0] as Evidence, b: (grouped[y] as Evidence[])[0] as Evidence });
    }
  }
  return { itemId, runId, field, status: 'conflict', evidence, missing: [], conflictPairs };
}

function indexByRunId<T extends { runId: string }>(runs: T[]): Map<string, { run: T; index: number }> {
  const map = new Map<string, { run: T; index: number }>();
  runs.forEach((run, index) => {
    if (!map.has(run.runId)) map.set(run.runId, { run, index });
  });
  return map;
}

export function verify(manifestDoc: JsonDocument, trajectoriesDoc: JsonDocument, fileSummariesDoc: JsonDocument): VerifyReport {
  const manifest = asManifest(manifestDoc);
  const trajectories = asTrajectories(trajectoriesDoc);
  const fileSummaries = asFileSummaries(fileSummariesDoc);

  const trajByRun = indexByRunId<TrajectoryRun>(trajectories.runs);
  const fsByRun = indexByRunId<FileSummaryRun>(fileSummaries.runs);
  const manifestRunIds = new Set(manifest.items.map((it) => it.runId));

  const checks: FieldCheck[] = [];

  manifest.items.forEach((item: ManifestItem, itemIdx: number) => {
    const itemPtr = `/items/${itemIdx}`;
    const traj = trajByRun.get(item.runId);
    const fs = fsByRun.get(item.runId);

    const trajMissing: MissingEvidence = {
      source: 'trajectory',
      file: trajectoriesDoc.name,
      reason: `轨迹中不存在运行ID "${item.runId}"`,
    };
    const fsMissing: MissingEvidence = {
      source: 'fileSummary',
      file: fileSummariesDoc.name,
      reason: `文件摘要中不存在运行ID "${item.runId}"`,
    };

    // 1) 运行ID：清单条目与轨迹、文件摘要的 (runId, itemId) 链式一致性
    const linkage = (runId: string, itemId: string): string => `${runId}::${itemId}`;
    checks.push(
      evaluateField(
        item.itemId,
        item.runId,
        'runId',
        [
          {
            source: 'manifest',
            value: linkage(item.runId, item.itemId),
            key: linkage(item.runId, item.itemId),
            citation: cite(manifestDoc, `${itemPtr}/runId`),
          },
          traj
            ? {
                source: 'trajectory',
                value: linkage(traj.run.runId, traj.run.itemId),
                key: linkage(traj.run.runId, traj.run.itemId),
                citation: cite(trajectoriesDoc, `/runs/${traj.index}/runId`),
              }
            : null,
          fs
            ? {
                source: 'fileSummary',
                value: linkage(fs.run.runId, fs.run.itemId),
                key: linkage(fs.run.runId, fs.run.itemId),
                citation: cite(fileSummariesDoc, `/runs/${fs.index}/runId`),
              }
            : null,
        ],
        [...(traj ? [] : [trajMissing]), ...(fs ? [] : [fsMissing])],
      ),
    );

    // 2) 题面摘要：三方一致
    checks.push(
      evaluateField(
        item.itemId,
        item.runId,
        'problemSummary',
        [
          {
            source: 'manifest',
            value: item.problemSummary,
            key: normalize(item.problemSummary),
            citation: cite(manifestDoc, `${itemPtr}/problemSummary`),
          },
          traj
            ? {
                source: 'trajectory',
                value: traj.run.problemSummary,
                key: normalize(traj.run.problemSummary),
                citation: cite(trajectoriesDoc, `/runs/${traj.index}/problemSummary`),
              }
            : null,
          fs
            ? {
                source: 'fileSummary',
                value: fs.run.problemSummary,
                key: normalize(fs.run.problemSummary),
                citation: cite(fileSummariesDoc, `/runs/${fs.index}/problemSummary`),
              }
            : null,
        ],
        [...(traj ? [] : [trajMissing]), ...(fs ? [] : [fsMissing])],
      ),
    );

    // 3) 阶段来源：清单声明的序列 vs 轨迹实际阶段来源序列
    const manifestStages = item.stageSources.join(' -> ');
    const trajStages = traj ? traj.run.stages.map((s) => s.source).join(' -> ') : null;
    checks.push(
      evaluateField(
        item.itemId,
        item.runId,
        'stageSources',
        [
          {
            source: 'manifest',
            value: manifestStages,
            key: item.stageSources.join(''),
            citation: cite(manifestDoc, `${itemPtr}/stageSources`),
          },
          traj
            ? {
                source: 'trajectory',
                value: trajStages as string,
                key: traj.run.stages.map((s) => s.source).join(''),
                citation: cite(trajectoriesDoc, `/runs/${traj.index}/stages`),
              }
            : null,
        ],
        traj ? [] : [trajMissing],
      ),
    );
  });

  // 孤儿运行：轨迹/文件摘要中存在但清单未登记 -> 缺失清单证据，标未知
  const orphans: OrphanRun[] = [];
  for (const { run, index } of trajByRun.values()) {
    if (!manifestRunIds.has(run.runId)) {
      orphans.push({
        runId: run.runId,
        source: 'trajectory',
        status: 'unknown',
        reason: '轨迹中的运行未在结果清单登记',
        citation: cite(trajectoriesDoc, `/runs/${index}/runId`),
      });
    }
  }
  for (const { run, index } of fsByRun.values()) {
    if (!manifestRunIds.has(run.runId)) {
      orphans.push({
        runId: run.runId,
        source: 'fileSummary',
        status: 'unknown',
        reason: '文件摘要中的运行未在结果清单登记',
        citation: cite(fileSummariesDoc, `/runs/${index}/runId`),
      });
    }
  }

  const summary: VerifySummary = {
    total: checks.length,
    consistent: checks.filter((c) => c.status === 'consistent').length,
    unknown: checks.filter((c) => c.status === 'unknown').length,
    conflict: checks.filter((c) => c.status === 'conflict').length,
    orphans: orphans.length,
  };
  return { checks, orphans, summary };
}
