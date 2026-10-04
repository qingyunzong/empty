import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  Citation,
  FIELDS,
  FieldName,
  Issue,
  SOURCE_FILES,
  SourceName,
} from "./model.js";
import { locateField } from "./locate.js";

export interface SourceRecord {
  itemId: string;
  fields: Map<FieldName, { value: string; citation: Citation }>;
  citation: Citation; // whole-record citation
}

export interface ParsedSource {
  source: SourceName;
  file: string;
  fileMissing: boolean;
  records: Map<string, SourceRecord>;
  issues: Issue[];
}

/** Load one JSONL evidence source, keeping per-field citation ranges. */
export function loadSource(dir: string, source: SourceName): ParsedSource {
  const file = join(dir, SOURCE_FILES[source]);
  const result: ParsedSource = {
    source,
    file,
    fileMissing: false,
    records: new Map(),
    issues: [],
  };
  if (!existsSync(file)) {
    result.fileMissing = true;
    result.issues.push({
      kind: "parse-error",
      itemId: null,
      field: null,
      message: `source file missing: ${SOURCE_FILES[source]}`,
      citations: [],
    });
    return result;
  }
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    const line = raw.trim();
    if (line === "") return;
    const wholeLine: Citation = {
      source,
      file,
      line: lineNo,
      colStart: 1,
      colEnd: raw.length + 1,
    };
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      result.issues.push({
        kind: "parse-error",
        itemId: null,
        field: null,
        message: `unparseable JSON line`,
        citations: [wholeLine],
      });
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      result.issues.push({
        kind: "parse-error",
        itemId: null,
        field: null,
        message: `line is not a JSON object`,
        citations: [wholeLine],
      });
      return;
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.itemId !== "string" || obj.itemId === "") {
      result.issues.push({
        kind: "parse-error",
        itemId: null,
        field: null,
        message: `record lacks a string "itemId"`,
        citations: [wholeLine],
      });
      return;
    }
    const itemId = obj.itemId;
    if (result.records.has(itemId)) {
      result.issues.push({
        kind: "duplicate-record",
        itemId,
        field: null,
        message: `duplicate record for item "${itemId}" in ${source}`,
        citations: [result.records.get(itemId)!.citation, wholeLine],
      });
      return; // first occurrence wins
    }
    const fields = new Map<FieldName, { value: string; citation: Citation }>();
    for (const field of FIELDS) {
      const v = obj[field];
      if (typeof v !== "string") continue; // missing or non-string: 缺失证据
      const span = locateField(raw, field);
      fields.set(field, {
        value: v,
        citation: {
          source,
          file,
          line: lineNo,
          colStart: span ? span.colStart : 1,
          colEnd: span ? span.colEnd : raw.length + 1,
        },
      });
    }
    result.records.set(itemId, {
      itemId,
      fields,
      citation: wholeLine,
    });
  });
  return result;
}
