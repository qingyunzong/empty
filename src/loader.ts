// 输入加载与结构校验：JSON 文档 -> 强类型数据
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { docFromText, type JsonDocument, type JsonValue } from './jsonpos.js';
import type { FileSummaries, Manifest, Trajectories } from './types.js';

export const MANIFEST_FILE = 'manifest.json';
export const TRAJECTORIES_FILE = 'trajectories.json';
export const FILE_SUMMARIES_FILE = 'file-summaries.json';

function isRecord(v: JsonValue): v is { [key: string]: JsonValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function needString(obj: { [key: string]: JsonValue }, key: string, where: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${where}: 字段 "${key}" 缺失或不是非空字符串`);
  return v;
}

function needNumber(obj: { [key: string]: JsonValue }, key: string, where: string): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${where}: 字段 "${key}" 缺失或不是数值`);
  return v;
}

function needArray(obj: { [key: string]: JsonValue }, key: string, where: string): JsonValue[] {
  const v = obj[key];
  if (!Array.isArray(v)) throw new Error(`${where}: 字段 "${key}" 缺失或不是数组`);
  return v;
}

export function asManifest(doc: JsonDocument): Manifest {
  const root = doc.value;
  if (!isRecord(root)) throw new Error(`${doc.name}: 根节点必须是对象`);
  const items = needArray(root, 'items', doc.name).map((raw, idx) => {
    const where = `${doc.name}#/items/${idx}`;
    if (!isRecord(raw)) throw new Error(`${where}: 条目必须是对象`);
    const stageSources = needArray(raw, 'stageSources', where).map((s, k) => {
      if (typeof s !== 'string' || s.length === 0) throw new Error(`${where}/stageSources/${k}: 必须是非空字符串`);
      return s;
    });
    return {
      itemId: needString(raw, 'itemId', where),
      runId: needString(raw, 'runId', where),
      problemSummary: needString(raw, 'problemSummary', where),
      stageSources,
    };
  });
  return { items };
}

export function asTrajectories(doc: JsonDocument): Trajectories {
  const root = doc.value;
  if (!isRecord(root)) throw new Error(`${doc.name}: 根节点必须是对象`);
  const runs = needArray(root, 'runs', doc.name).map((raw, idx) => {
    const where = `${doc.name}#/runs/${idx}`;
    if (!isRecord(raw)) throw new Error(`${where}: 条目必须是对象`);
    const stages = needArray(raw, 'stages', where).map((s, k) => {
      const swhere = `${where}/stages/${k}`;
      if (!isRecord(s)) throw new Error(`${swhere}: 阶段必须是对象`);
      return { name: needString(s, 'name', swhere), source: needString(s, 'source', swhere) };
    });
    return {
      runId: needString(raw, 'runId', where),
      itemId: needString(raw, 'itemId', where),
      problemSummary: needString(raw, 'problemSummary', where),
      stages,
    };
  });
  return { runs };
}

export function asFileSummaries(doc: JsonDocument): FileSummaries {
  const root = doc.value;
  if (!isRecord(root)) throw new Error(`${doc.name}: 根节点必须是对象`);
  const runs = needArray(root, 'runs', doc.name).map((raw, idx) => {
    const where = `${doc.name}#/runs/${idx}`;
    if (!isRecord(raw)) throw new Error(`${where}: 条目必须是对象`);
    const files = needArray(raw, 'files', where).map((f, k) => {
      const fwhere = `${where}/files/${k}`;
      if (!isRecord(f)) throw new Error(`${fwhere}: 文件条目必须是对象`);
      return {
        path: needString(f, 'path', fwhere),
        sha256: needString(f, 'sha256', fwhere),
        bytes: needNumber(f, 'bytes', fwhere),
      };
    });
    return {
      runId: needString(raw, 'runId', where),
      itemId: needString(raw, 'itemId', where),
      problemSummary: needString(raw, 'problemSummary', where),
      files,
    };
  });
  return { runs };
}

export interface InputDocs {
  manifest: JsonDocument;
  trajectories: JsonDocument;
  fileSummaries: JsonDocument;
}

export function loadInputDocs(dir: string): InputDocs {
  const load = (file: string): JsonDocument => docFromText(file, readFileSync(join(dir, file), 'utf8'));
  return {
    manifest: load(MANIFEST_FILE),
    trajectories: load(TRAJECTORIES_FILE),
    fileSummaries: load(FILE_SUMMARIES_FILE),
  };
}
