/**
 * 在线/离线特征对账组件。
 *
 * 将离线表分区中的特征行与在线 KV 快照按 (entityId, feature, featureVersion)
 * 对齐，并基于事件时间比较取值。组件只读输入、只输出差异报告与两侧来源
 * 证据，绝不回写或自动覆盖任何一侧的数据。
 */

export type FeatureValue = number | string | boolean | null;

export type FeatureValueType = "float" | "int" | "string" | "boolean";

/** 浮点比较容差：绝对容差与相对容差取二者放宽后的上限。 */
export interface FloatTolerance {
  abs?: number;
  rel?: number;
}

export interface FeatureDefinition {
  name: string;
  /** 期望的特征定义版本，两侧版本不一致时单独分类。 */
  version: string;
  valueType: FeatureValueType;
  /** 仅 float 类型生效。 */
  tolerance?: FloatTolerance;
  /**
   * 可选：在线值的最大有效时长（毫秒）。在线记录的事件时间早于
   * nowMs - ttlMs 时视为过期，即使数值碰巧一致也按 stale 分类。
   */
  ttlMs?: number;
}

/** 离线表分区中的一行特征。 */
export interface OfflineRow {
  entityId: string;
  feature: string;
  featureVersion: string;
  eventTimeMs: number;
  value: FeatureValue;
  /** 来源证据，例如 "dt=2026-11-13/hr=10"。 */
  partition?: string;
}

/** 在线 KV 快照中的一条记录。 */
export interface OnlineRecord {
  entityId: string;
  feature: string;
  featureVersion: string;
  eventTimeMs: number;
  value: FeatureValue;
  /** KV 写入时间，用于证据展示。 */
  writtenAtMs?: number;
  /** 来源证据，例如 "feat:click_cnt:u123"。 */
  key?: string;
}

export type DiffKind =
  | "missing_online" // 离线有、在线无
  | "unexpected_online" // 在线有、离线无
  | "version_mismatch" // 特征定义版本不一致
  | "stale_online" // 在线值过期（事件时间落后或超 TTL），与真实不一致区分
  | "value_mismatch"; // 真实取值不一致（浮点按字段容差判定）

export interface SourceEvidence {
  source: "offline_partition" | "online_kv";
  /** 分区路径或 KV key。 */
  location: string;
  featureVersion: string;
  eventTimeMs: number;
  value: FeatureValue;
}

export interface ReconcileDiff {
  kind: DiffKind;
  entityId: string;
  feature: string;
  expectedVersion: string;
  detail: string;
  offlineEvidence?: SourceEvidence;
  onlineEvidence?: SourceEvidence;
}

export interface ReconcileOptions {
  definitions: FeatureDefinition[];
  /** 采样率 [0,1]，默认 1（全量）。是否命中由稳定 hash 决定。 */
  sampleRate?: number;
  /** 采样 hash 的盐，便于不同批次得到不同样本。 */
  sampleSalt?: string;
  /** 判定 TTL 过期所用的当前时间，默认 Date.now()。 */
  nowMs?: number;
}

export interface ReconcileReport {
  totalOfflineRows: number;
  totalOnlineRecords: number;
  sampledEntities: number;
  diffs: ReconcileDiff[];
  summary: Record<DiffKind, number>;
}

const DIFF_KINDS: DiffKind[] = [
  "missing_online",
  "unexpected_online",
  "version_mismatch",
  "stale_online",
  "value_mismatch",
];

/**
 * FNV-1a 32 位稳定 hash。不依赖运行环境，同一输入在任何机器上
 * 得到同一结果，因此采样集合可复现。
 */
export function stableHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 由稳定 hash 决定某实体某特征是否进入样本。 */
export function shouldSample(
  entityId: string,
  feature: string,
  sampleRate: number,
  salt = "",
): boolean {
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;
  const bucket = stableHash(`${salt}:${entityId}:${feature}`) / 0x100000000;
  return bucket < sampleRate;
}

/** 浮点比较：|a-b| <= max(absTol, relTol * max(|a|, |b|))。NaN 与任何值（含自身）都不相等。 */
export function floatsEqual(
  a: number,
  b: number,
  tolerance: FloatTolerance = {},
): boolean {
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  if (Object.is(a, b)) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const absTol = tolerance.abs ?? 0;
  const relTol = tolerance.rel ?? 0;
  const limit = Math.max(absTol, relTol * Math.max(Math.abs(a), Math.abs(b)));
  return Math.abs(a - b) <= limit;
}

export function valuesEqual(
  a: FeatureValue,
  b: FeatureValue,
  def: FeatureDefinition,
): boolean {
  if (def.valueType === "float") {
    if (typeof a !== "number" || typeof b !== "number") return a === b;
    return floatsEqual(a, b, def.tolerance);
  }
  return a === b;
}

function offlineEvidence(row: OfflineRow): SourceEvidence {
  return {
    source: "offline_partition",
    location: row.partition ?? "<unknown-partition>",
    featureVersion: row.featureVersion,
    eventTimeMs: row.eventTimeMs,
    value: row.value,
  };
}

function onlineEvidence(rec: OnlineRecord): SourceEvidence {
  return {
    source: "online_kv",
    location: rec.key ?? "<unknown-key>",
    featureVersion: rec.featureVersion,
    eventTimeMs: rec.eventTimeMs,
    value: rec.value,
  };
}

function rowKey(entityId: string, feature: string): string {
  return `${entityId}::${feature}`;
}

function fallbackDef(row: OfflineRow): FeatureDefinition {
  return {
    name: row.feature,
    version: row.featureVersion,
    valueType: typeof row.value === "number" ? "float" : "string",
  };
}

/**
 * 对账主入口。只读两侧输入，返回差异报告；不做任何写回。
 *
 * 判定顺序：版本不一致 > 在线过期（stale）> 取值不一致。
 * 在线记录事件时间早于离线行，或超出特征 TTL 时，归为
 * stale_online 而非 value_mismatch。
 */
export function reconcile(
  offlineRows: OfflineRow[],
  onlineRecords: OnlineRecord[],
  options: ReconcileOptions,
): ReconcileReport {
  const sampleRate = options.sampleRate ?? 1;
  const salt = options.sampleSalt ?? "";
  const nowMs = options.nowMs ?? Date.now();
  const defs = new Map(options.definitions.map((d) => [d.name, d]));

  const onlineByKey = new Map<string, OnlineRecord>();
  for (const rec of onlineRecords) {
    onlineByKey.set(rowKey(rec.entityId, rec.feature), rec);
  }
  const allOfflineKeys = new Set<string>();
  for (const row of offlineRows) {
    allOfflineKeys.add(rowKey(row.entityId, row.feature));
  }

  const diffs: ReconcileDiff[] = [];
  const matchedOnlineKeys = new Set<string>();
  const countedEntities = new Set<string>();
  let sampledEntities = 0;

  for (const row of offlineRows) {
    if (!shouldSample(row.entityId, row.feature, sampleRate, salt)) continue;
    const key = rowKey(row.entityId, row.feature);
    if (!countedEntities.has(row.entityId)) {
      countedEntities.add(row.entityId);
      sampledEntities++;
    }

    const def = defs.get(row.feature);
    const expectedVersion = def?.version ?? row.featureVersion;
    const online = onlineByKey.get(key);

    if (!online) {
      diffs.push({
        kind: "missing_online",
        entityId: row.entityId,
        feature: row.feature,
        expectedVersion,
        detail: "离线分区存在该行，但在线 KV 快照中缺失",
        offlineEvidence: offlineEvidence(row),
      });
      continue;
    }
    matchedOnlineKeys.add(key);

    if (online.featureVersion !== row.featureVersion) {
      diffs.push({
        kind: "version_mismatch",
        entityId: row.entityId,
        feature: row.feature,
        expectedVersion,
        detail: `特征定义版本不一致：离线=${row.featureVersion} 在线=${online.featureVersion}`,
        offlineEvidence: offlineEvidence(row),
        onlineEvidence: onlineEvidence(online),
      });
      continue;
    }

    const effectiveDef = def ?? fallbackDef(row);
    const staleByEventTime = online.eventTimeMs < row.eventTimeMs;
    const staleByTtl =
      def?.ttlMs !== undefined && online.eventTimeMs < nowMs - def.ttlMs;
    if (staleByEventTime || staleByTtl) {
      // 过期在线值：取值仍一致时不产生差异，否则归为 stale 而非真实不一致。
      if (!valuesEqual(row.value, online.value, effectiveDef)) {
        diffs.push({
          kind: "stale_online",
          entityId: row.entityId,
          feature: row.feature,
          expectedVersion,
          detail: staleByTtl
            ? `在线值已过期（超出 TTL ${def?.ttlMs}ms），且与离线取值不同`
            : `在线事件时间 ${online.eventTimeMs} 落后于离线 ${row.eventTimeMs}，且取值不同`,
          offlineEvidence: offlineEvidence(row),
          onlineEvidence: onlineEvidence(online),
        });
      }
      continue;
    }

    if (!valuesEqual(row.value, online.value, effectiveDef)) {
      diffs.push({
        kind: "value_mismatch",
        entityId: row.entityId,
        feature: row.feature,
        expectedVersion,
        detail: `取值不一致：离线=${String(row.value)} 在线=${String(online.value)}`,
        offlineEvidence: offlineEvidence(row),
        onlineEvidence: onlineEvidence(online),
      });
    }
  }

  for (const rec of onlineRecords) {
    const key = rowKey(rec.entityId, rec.feature);
    if (matchedOnlineKeys.has(key)) continue;
    // 离线侧存在该 key 但未采样时，不属于"在线多出"。
    if (allOfflineKeys.has(key)) continue;
    if (!shouldSample(rec.entityId, rec.feature, sampleRate, salt)) continue;
    const def = defs.get(rec.feature);
    diffs.push({
      kind: "unexpected_online",
      entityId: rec.entityId,
      feature: rec.feature,
      expectedVersion: def?.version ?? rec.featureVersion,
      detail: "在线 KV 快照存在该记录，但离线分区中缺失",
      onlineEvidence: onlineEvidence(rec),
    });
  }

  const summary = Object.fromEntries(
    DIFF_KINDS.map((k) => [k, 0]),
  ) as Record<DiffKind, number>;
  for (const diff of diffs) summary[diff.kind]++;

  return {
    totalOfflineRows: offlineRows.length,
    totalOnlineRecords: onlineRecords.length,
    sampledEntities,
    diffs,
    summary,
  };
}
