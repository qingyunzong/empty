import { TemplateError } from "./errors";
import type { SourcePosition } from "./errors";
import { safeStringify } from "./secure";

export type Filter = (value: unknown, args: unknown[], pos: SourcePosition) => unknown;

function scalar(value: unknown, pos: SourcePosition, what: string): string {
  if (value === null || value === undefined) return "";
  const kind = typeof value;
  if (kind === "string") return value as string;
  if (kind === "number" || kind === "boolean") return String(value);
  throw new TemplateError(`filter "${what}" expects a scalar value, got ${kind}`, pos);
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const builtinFilters: Record<string, Filter> = {
  upper: (value, _args, pos) => scalar(value, pos, "upper").toUpperCase(),
  lower: (value, _args, pos) => scalar(value, pos, "lower").toLowerCase(),
  escape: (value, _args, pos) =>
    scalar(value, pos, "escape").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c),
  length: (value, _args, pos) => {
    if (typeof value === "string" || Array.isArray(value)) return value.length;
    throw new TemplateError('filter "length" expects a string or an array', pos);
  },
  join: (value, args, pos) => {
    if (!Array.isArray(value)) {
      throw new TemplateError('filter "join" expects an array', pos);
    }
    const separator = args.length > 0 ? scalar(args[0], pos, "join") : ",";
    return value.map((item) => scalar(item, pos, "join")).join(separator);
  },
  json: (value, _args, pos) => safeStringify(value, pos),
  default: (value, args) =>
    value === null || value === undefined || value === "" ? args[0] ?? "" : value,
};
