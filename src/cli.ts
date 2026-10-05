import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { SchemaError } from "./errors.js";
import { parse, type Engine } from "./parse.js";

export interface CliIO {
  out(chunk: string): void;
  err(chunk: string): void;
}

function usage(err: (chunk: string) => void): void {
  err(
    "usage: cli.js <schema.json> <data.bin> [--engine compile|interpret] [--offset N]\n" +
      "  解析成功输出 { ok:true, offset, value }（bytes 以 hex 字符串表示），退出码 0；\n" +
      "  数据解析失败输出 { ok:false, offset, error }，退出码 1；用法或 schema 错误退出码 2。\n"
  );
}

function toJsonable(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return value.toString("hex");
  }
  if (Array.isArray(value)) {
    return value.map(toJsonable);
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toJsonable(v);
    }
    return out;
  }
  return value;
}

/** CLI 主逻辑：返回退出码（0 成功 / 1 数据解析失败 / 2 用法或 schema 错误）。 */
export function main(args: string[], io: CliIO): number {
  const positional: string[] = [];
  let engine: Engine = "compile";
  let offset = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--engine") {
      const e = args[++i];
      if (e !== "compile" && e !== "interpret") {
        io.err(`invalid --engine "${String(e)}"\n`);
        usage(io.err);
        return 2;
      }
      engine = e;
    } else if (a === "--offset") {
      const o = Number(args[++i]);
      if (!Number.isSafeInteger(o) || o < 0) {
        io.err(`invalid --offset "${String(args[i])}"\n`);
        usage(io.err);
        return 2;
      }
      offset = o;
    } else if (a === "--help" || a === "-h") {
      usage(io.err);
      return 0;
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 2) {
    usage(io.err);
    return 2;
  }
  const [schemaPath, dataPath] = positional as [string, string];

  let schema: unknown;
  try {
    schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  } catch (err) {
    io.err(`cannot load schema file "${schemaPath}": ${(err as Error).message}\n`);
    return 2;
  }
  let data: Buffer;
  try {
    data = readFileSync(dataPath);
  } catch (err) {
    io.err(`cannot read data file "${dataPath}": ${(err as Error).message}\n`);
    return 2;
  }

  try {
    const result = parse(schema, data, { engine, offset });
    if (result.ok) {
      io.out(JSON.stringify({ ok: true, offset: result.offset, value: toJsonable(result.value) }, null, 2) + "\n");
      return 0;
    }
    io.out(JSON.stringify({ ok: false, offset: result.offset, error: result.error }, null, 2) + "\n");
    return 1;
  } catch (err) {
    if (err instanceof SchemaError || err instanceof RangeError) {
      io.err(`${(err as Error).name}: ${(err as Error).message}\n`);
      return 2;
    }
    throw err;
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = main(process.argv.slice(2), {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  });
}
