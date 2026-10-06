export const MAX_PACKAGES = 18;

export interface DeltaPackage {
  id: string;
  from: string;
  to: string;
  bytes: number;
}

export interface Problem {
  source: string;
  target: string;
  spaceLimitBytes: number;
  packages: DeltaPackage[];
}

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readName(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InputError(`字段 "${field}" 必须是非空字符串`);
  }
  return value;
}

function readNonNegativeInt(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new InputError(`字段 "${field}" 必须是非负整数（字节）`);
  }
  return value;
}

export function parseProblem(raw: unknown): Problem {
  if (!isRecord(raw)) {
    throw new InputError("输入必须是 JSON 对象");
  }
  const source = readName(raw, "source");
  const target = readName(raw, "target");
  const spaceLimitBytes = readNonNegativeInt(raw, "spaceLimitBytes");
  const rawPackages = raw["packages"];
  if (!Array.isArray(rawPackages)) {
    throw new InputError('字段 "packages" 必须是数组');
  }
  if (rawPackages.length > MAX_PACKAGES) {
    throw new InputError(`差量包数量 ${rawPackages.length} 超过上限 ${MAX_PACKAGES}`);
  }
  const seen = new Set<string>();
  const packages: DeltaPackage[] = rawPackages.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new InputError(`packages[${index}] 必须是对象`);
    }
    const id = readName(entry, "id");
    if (seen.has(id)) {
      throw new InputError(`包 id "${id}" 重复`);
    }
    seen.add(id);
    const from = readName(entry, "from");
    const to = readName(entry, "to");
    if (from === to) {
      throw new InputError(`包 "${id}" 的 from 与 to 相同（自环无意义）`);
    }
    const bytes = readNonNegativeInt(entry, "bytes");
    if (bytes === 0) {
      throw new InputError(`包 "${id}" 的 bytes 必须是正整数`);
    }
    return { id, from, to, bytes };
  });
  return { source, target, spaceLimitBytes, packages };
}

export function loadProblem(text: string): Problem {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new InputError(`JSON 解析失败: ${(error as Error).message}`);
  }
  return parseProblem(raw);
}
