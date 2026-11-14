/**
 * 缺失值归一组件：按字段 schema 区分 absent / null / empty / NaN / sentinel / redacted。
 *
 * 设计约束：
 * - 映射规则版本化（Ruleset.version），每条证据都携带版本号；
 * - 原始表示（absent 键缺失 / undefined 值 / 原始字面值）完整保留在证据中，支持无损回查；
 * - 合法零值（0、0n、false）与空集合（[]、{}）默认视为有效值，绝不归为缺失；
 * - 证据可 JSON 序列化（NaN / undefined 等特殊值使用 tagged 编码）。
 */

export type MissingCategory =
  | 'absent'
  | 'null'
  | 'empty'
  | 'nan'
  | 'sentinel'
  | 'redacted'
  | 'present';

export type FieldType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'array'
  | 'object'
  | 'any';

export interface FieldSchema {
  /** 字段数据类型，用于有效值校验。 */
  type: FieldType;
  /** 该字段的哨兵值列表（如 -999、"N/A"），命中归为 sentinel。 */
  sentinels?: readonly unknown[];
  /** 该字段的脱敏标记列表（如 "***"、"[REDACTED]"），命中归为 redacted。 */
  redactedMarkers?: readonly unknown[];
  /** 字符串字段：空白串（trim 后为空）是否归为 empty。默认 true。 */
  emptyStringIsMissing?: boolean;
  /** 集合字段：空数组/空对象是否归为 empty。默认 false（空集合是合法值）。 */
  emptyCollectionIsMissing?: boolean;
}

export interface MappingRuleset {
  /** 规则版本，语义化版本字符串，写入每条证据。 */
  version: string;
  /** 字段名 → 字段 schema。未在 schema 中声明的字段按 any 透传。 */
  fields: Readonly<Record<string, FieldSchema>>;
}

/** 原始表示的可序列化编码，保证跨进程/跨存储无损。 */
export type EncodedOriginal =
  | { form: 'absent-key' }
  | { form: 'undefined-value' }
  | { form: 'value'; raw: unknown };

export interface RuleEvidence {
  /** 命中的规则集版本。 */
  rulesetVersion: string;
  /** 字段名。 */
  field: string;
  /** 命中的规则标识，如 "absent:key-missing"、"sentinel:schema-match"。 */
  ruleId: string;
  /** 原始表示（tagged 编码，JSON 安全）。 */
  original: EncodedOriginal;
  /** 命中的哨兵值/脱敏标记（仅 sentinel / redacted 类别）。 */
  matchedToken?: unknown;
}

export interface NormalizedField<T = unknown> {
  /** 归一后的值；缺失类别下为 undefined。 */
  value: T | undefined;
  /** 缺失类别；有效值为 'present'。 */
  category: MissingCategory;
  /** 是否为有效值。 */
  present: boolean;
  /** 规则证据，支持无损回查。 */
  evidence: RuleEvidence;
}

export type NormalizedRecord = Record<string, NormalizedField>;

const MV_TAG = '__mv_tag';

function encodeRaw(raw: unknown): EncodedOriginal {
  if (typeof raw === 'number' && Number.isNaN(raw)) {
    return { form: 'value', raw: { [MV_TAG]: 'NaN' } };
  }
  if (typeof raw === 'undefined') {
    return { form: 'value', raw: { [MV_TAG]: 'undefined' } };
  }
  if (typeof raw === 'bigint') {
    return { form: 'value', raw: { [MV_TAG]: 'bigint', value: raw.toString() } };
  }
  return { form: 'value', raw };
}

function decodeRaw(encoded: EncodedOriginal): unknown {
  if (encoded.form === 'absent-key' || encoded.form === 'undefined-value') {
    return undefined;
  }
  const raw = encoded.raw as Record<string, unknown> | null;
  if (
    raw !== null &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    (raw as Record<string, unknown>)[MV_TAG] !== undefined
  ) {
    const tag = (raw as Record<string, unknown>)[MV_TAG];
    if (tag === 'NaN') return NaN;
    if (tag === 'undefined') return undefined;
    if (tag === 'bigint') return BigInt((raw as { value: string }).value);
  }
  return encoded.raw;
}

function tokenEquals(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }
  return Object.is(a, b);
}

function isValidValue(value: unknown, type: FieldType): boolean {
  switch (type) {
    case 'any':
      return true;
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && !Number.isNaN(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}

function makeEvidence(
  ruleset: MappingRuleset,
  field: string,
  ruleId: string,
  original: EncodedOriginal,
  matchedToken?: unknown,
): RuleEvidence {
  const evidence: RuleEvidence = {
    rulesetVersion: ruleset.version,
    field,
    ruleId,
    original,
  };
  if (matchedToken !== undefined) {
    evidence.matchedToken = matchedToken;
  }
  return evidence;
}

function missing(
  ruleset: MappingRuleset,
  field: string,
  category: Exclude<MissingCategory, 'present'>,
  ruleId: string,
  original: EncodedOriginal,
  matchedToken?: unknown,
): NormalizedField {
  return {
    value: undefined,
    category,
    present: false,
    evidence: makeEvidence(ruleset, field, ruleId, original, matchedToken),
  };
}

/**
 * 归一单个字段。record 中键缺失与值为 undefined 被区分记录，
 * 以保证回查时能还原精确的原始表示。
 */
export function normalizeField(
  record: Readonly<Record<string, unknown>>,
  field: string,
  ruleset: MappingRuleset,
): NormalizedField {
  const schema: FieldSchema = ruleset.fields[field] ?? { type: 'any' };

  if (!Object.prototype.hasOwnProperty.call(record, field)) {
    return missing(ruleset, field, 'absent', 'absent:key-missing', { form: 'absent-key' });
  }

  const raw = record[field];

  if (typeof raw === 'undefined') {
    return missing(ruleset, field, 'absent', 'absent:undefined-value', { form: 'undefined-value' });
  }

  if (raw === null) {
    return missing(ruleset, field, 'null', 'null:explicit-null', encodeRaw(raw));
  }

  if (typeof raw === 'number' && Number.isNaN(raw)) {
    return missing(ruleset, field, 'nan', 'nan:number-nan', encodeRaw(raw));
  }

  for (const marker of schema.redactedMarkers ?? []) {
    if (tokenEquals(raw, marker)) {
      return missing(ruleset, field, 'redacted', 'redacted:schema-match', encodeRaw(raw), marker);
    }
  }

  for (const sentinel of schema.sentinels ?? []) {
    if (tokenEquals(raw, sentinel)) {
      return missing(ruleset, field, 'sentinel', 'sentinel:schema-match', encodeRaw(raw), sentinel);
    }
  }

  if (typeof raw === 'string') {
    const emptyCheck = schema.emptyStringIsMissing ?? true;
    if (emptyCheck && raw.trim().length === 0) {
      return missing(ruleset, field, 'empty', 'empty:blank-string', encodeRaw(raw));
    }
  }

  if (Array.isArray(raw) || (typeof raw === 'object' && raw !== null)) {
    const isEmptyCollection = Array.isArray(raw)
      ? raw.length === 0
      : Object.keys(raw as Record<string, unknown>).length === 0;
    // 空集合默认是合法值，仅当 schema 显式开启时才归为 empty。
    if (isEmptyCollection && (schema.emptyCollectionIsMissing ?? false)) {
      return missing(ruleset, field, 'empty', 'empty:empty-collection', encodeRaw(raw));
    }
  }

  // 合法零值（0、0n、false）与空集合走到这里，按有效值处理。
  if (!isValidValue(raw, schema.type)) {
    return missing(ruleset, field, 'absent', 'absent:type-mismatch', encodeRaw(raw));
  }

  return {
    value: raw,
    category: 'present',
    present: true,
    evidence: makeEvidence(ruleset, field, 'present:valid', encodeRaw(raw)),
  };
}

/** 归一整条记录：schema 中声明的每个字段都会得到归一结果。 */
export function normalizeRecord(
  record: Readonly<Record<string, unknown>>,
  ruleset: MappingRuleset,
): NormalizedRecord {
  const out: NormalizedRecord = {};
  for (const field of Object.keys(ruleset.fields)) {
    out[field] = normalizeField(record, field, ruleset);
  }
  return out;
}

/** 从归一结果无损还原单个字段的原始表示。 */
export function restoreField(normalized: NormalizedField): { present: boolean; value?: unknown } {
  const original = normalized.evidence.original;
  if (original.form === 'absent-key') {
    return { present: false };
  }
  if (original.form === 'undefined-value') {
    return { present: true, value: undefined };
  }
  return { present: true, value: decodeRaw(original) };
}

/**
 * 从归一记录无损还原原始记录：
 * absent 键保持缺失，undefined 值、NaN、哨兵原样还原。
 */
export function restoreRecord(normalized: NormalizedRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, nf] of Object.entries(normalized)) {
    const restored = restoreField(nf);
    if (restored.present) {
      out[field] = restored.value;
    }
  }
  return out;
}

/** 证据的 JSON 序列化 / 反序列化（tagged 编码保证 NaN、undefined、bigint 无损）。 */
export function serializeEvidence(evidence: RuleEvidence): string {
  return JSON.stringify(evidence);
}

export function deserializeEvidence(json: string): RuleEvidence {
  return JSON.parse(json) as RuleEvidence;
}
