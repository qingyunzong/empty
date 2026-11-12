export type TransactionId = bigint | string | number;

export interface Interval {
  start: bigint;
  end: bigint;
}

export interface PositionGroup {
  sid: string;
  label: string | null;
  intervals: Interval[];
  readonly tag?: string | null;
}

export interface PositionSet {
  groups: PositionGroup[];
}

export interface ParseSuccess {
  ok: true;
  value: PositionSet;
  readonly set?: PositionSet;
  readonly groups?: PositionGroup[];
  readonly text?: string;
}

export interface ParseFailure {
  ok: false;
  offset: number;
  error: string;
  readonly message?: string;
  readonly byteOffset?: number;
}

export type ParseResult = ParseSuccess | ParseFailure;
export type PositionInput = string | PositionSet | ParseResult;

export const MAX_TRANSACTION_ID = 9223372036854775807n;

const MAX_TRANSACTION_TEXT = MAX_TRANSACTION_ID.toString();
const SID_LENGTH = 32;
const MAX_LABEL_LENGTH = 32;

export class PositionParseError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`${message} at byte ${offset}`);
    this.name = "PositionParseError";
    this.offset = offset;
  }
}

class InternalParseFailure extends Error {
  readonly index: number;

  constructor(message: string, index: number) {
    super(message);
    this.index = index;
  }
}

function fail(index: number, message: string): never {
  throw new InternalParseFailure(message, index);
}

function isHexCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 70) ||
    (code >= 97 && code <= 102)
  );
}

function isDigitCode(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isLetterOrUnderscore(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

function isLabelCode(code: number): boolean {
  return isLetterOrUnderscore(code) || isDigitCode(code);
}

function byteOffset(input: string, index: number): number {
  const limit = Math.max(0, Math.min(index, input.length));
  let offset = 0;

  for (let i = 0; i < limit; i += 1) {
    const code = input.charCodeAt(i);
    if (code <= 0x7f) {
      offset += 1;
    } else if (code <= 0x7ff) {
      offset += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < limit) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        offset += 4;
        i += 1;
      } else {
        offset += 3;
      }
    } else {
      offset += 3;
    }
  }

  return offset;
}

function parseNumber(input: string, start: number, end: number): bigint {
  if (start >= end) {
    fail(start, "expected a transaction number");
  }

  if (input.charCodeAt(start) === 48) {
    if (end - start === 1) {
      fail(start, "transaction number 0 is not allowed");
    }
    fail(start, "transaction number must not have a leading zero");
  }

  for (let i = start; i < end; i += 1) {
    if (!isDigitCode(input.charCodeAt(i))) {
      fail(i, "expected a decimal digit");
    }
  }

  const text = input.slice(start, end);
  if (
    text.length > MAX_TRANSACTION_TEXT.length ||
    (text.length === MAX_TRANSACTION_TEXT.length && text > MAX_TRANSACTION_TEXT)
  ) {
    fail(start, "transaction number exceeds 9223372036854775807");
  }

  return BigInt(text);
}

function parseIntervalFragment(
  input: string,
  start: number,
  end: number,
): Interval {
  let dash = -1;

  for (let i = start; i < end; i += 1) {
    if (input.charCodeAt(i) === 45) {
      if (dash !== -1) {
        fail(i, "interval contains more than one '-'");
      }
      dash = i;
    }
  }

  if (dash === -1) {
    const value = parseNumber(input, start, end);
    return { start: value, end: value };
  }

  if (dash === start) {
    fail(start, "interval is missing its start");
  }
  if (dash + 1 === end) {
    fail(end, "interval is missing its end");
  }

  const intervalStart = parseNumber(input, start, dash);
  const intervalEnd = parseNumber(input, dash + 1, end);
  if (intervalStart > intervalEnd) {
    fail(dash + 1, "interval start must not be greater than its end");
  }

  return { start: intervalStart, end: intervalEnd };
}

function parseIntervalList(
  input: string,
  start: number,
  end: number,
): Interval[] {
  if (start >= end) {
    fail(start, "expected at least one interval");
  }

  const intervals: Interval[] = [];
  let cursor = start;

  while (true) {
    const colon = input.indexOf(":", cursor);
    const fragmentEnd = colon === -1 || colon >= end ? end : colon;

    if (cursor === fragmentEnd) {
      fail(cursor, "empty interval");
    }

    intervals.push(parseIntervalFragment(input, cursor, fragmentEnd));

    if (colon === -1 || colon >= end) {
      break;
    }
    cursor = colon + 1;
  }

  return intervals;
}

function parseLabel(input: string, start: number, end: number): string {
  if (start >= end) {
    fail(start, "expected a label");
  }

  if (end - start > MAX_LABEL_LENGTH) {
    fail(start + MAX_LABEL_LENGTH, "label is longer than 32 characters");
  }

  if (!isLetterOrUnderscore(input.charCodeAt(start))) {
    fail(start, "label must start with a letter or underscore");
  }

  for (let i = start + 1; i < end; i += 1) {
    if (!isLabelCode(input.charCodeAt(i))) {
      fail(i, "label may contain only letters, digits, and underscores");
    }
  }

  return input.slice(start, end);
}

function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  if (intervals.length === 0) {
    return [];
  }

  const sorted = intervals
    .map((interval) => ({ start: interval.start, end: interval.end }))
    .sort((left, right) =>
      left.start < right.start
        ? -1
        : left.start > right.start
          ? 1
          : left.end < right.end
            ? -1
            : left.end > right.end
              ? 1
              : 0,
    );

  const merged: Interval[] = [{ start: sorted[0].start, end: sorted[0].end }];

  for (let i = 1; i < sorted.length; i += 1) {
    const next = sorted[i];
    const last = merged[merged.length - 1];

    const overlaps = next.start <= last.end;
    const adjacent =
      last.end < MAX_TRANSACTION_ID && next.start === last.end + 1n;

    if (overlaps || adjacent) {
      if (next.end > last.end) {
        last.end = next.end;
      }
    } else {
      merged.push({ start: next.start, end: next.end });
    }
  }

  return merged;
}

function compareLabels(left: string | null, right: string | null): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return -1;
  }
  if (right === null) {
    return 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortGroups(groups: PositionGroup[]): PositionGroup[] {
  groups.sort((left, right) => {
    if (left.sid !== right.sid) {
      return left.sid < right.sid ? -1 : 1;
    }
    return compareLabels(left.label, right.label);
  });
  return groups;
}

function groupKey(sid: string, label: string | null): string {
  return `${sid}\u0000${label ?? ""}`;
}

function addIntervals(
  groups: Map<string, PositionGroup>,
  sid: string,
  label: string | null,
  intervals: Interval[],
): void {
  const key = groupKey(sid, label);
  const existing = groups.get(key);
  if (existing) {
    existing.intervals.push(...intervals);
    return;
  }
  groups.set(key, { sid, label, intervals: [...intervals] });
}

function finishGroups(groups: Map<string, PositionGroup>): PositionSet {
  const result: PositionGroup[] = [];
  for (const group of groups.values()) {
    const merged = mergeIntervals(group.intervals);
    if (merged.length > 0) {
      const exposed: PositionGroup = {
        sid: group.sid,
        label: group.label,
        intervals: merged,
      };
      Object.defineProperty(exposed, "tag", {
        enumerable: false,
        get() {
          return exposed.label;
        },
      });
      result.push(exposed);
    }
  }
  sortGroups(result);
  return { groups: result };
}

function parseText(input: string, groups: Map<string, PositionGroup>): void {
  if (typeof input !== "string") {
    fail(0, "input must be a string");
  }

  for (let i = 0; i < input.length; i += 1) {
    if (/\s/.test(input[i])) {
      fail(i, "whitespace is not allowed");
    }
  }

  if (input.length === 0) {
    return;
  }

  let sectionStart = 0;

  while (true) {
    const comma = input.indexOf(",", sectionStart);
    const sectionEnd = comma === -1 ? input.length : comma;

    if (sectionStart === sectionEnd) {
      fail(sectionStart, "empty section");
    }

    const sidEnd = sectionStart + SID_LENGTH;
    const availableSidEnd = Math.min(sidEnd, sectionEnd);
    for (let i = sectionStart; i < availableSidEnd; i += 1) {
      if (!isHexCode(input.charCodeAt(i))) {
        fail(i, "SID must contain exactly 32 hexadecimal characters");
      }
    }

    if (sidEnd >= sectionEnd) {
      fail(
        sectionEnd,
        "section must contain a 32-character SID followed by ':'",
      );
    }

    if (input[sidEnd] !== ":") {
      fail(sidEnd, "expected ':' after the SID");
    }

    const sid = input.slice(sectionStart, sidEnd).toLowerCase();
    const contentStart = sidEnd + 1;
    if (contentStart >= sectionEnd) {
      fail(contentStart, "expected at least one interval");
    }

    const firstColon = input.indexOf(":", contentStart);
    const firstEnd =
      firstColon === -1 || firstColon >= sectionEnd ? sectionEnd : firstColon;

    if (isDigitCode(input.charCodeAt(contentStart))) {
      const intervals = parseIntervalList(input, contentStart, sectionEnd);
      addIntervals(groups, sid, null, intervals);
    } else {
      const label = parseLabel(input, contentStart, firstEnd);
      if (firstEnd >= sectionEnd) {
        fail(sectionEnd, "a label must be followed by ':' and an interval");
      }

      const intervals = parseIntervalList(input, firstEnd + 1, sectionEnd);
      addIntervals(groups, sid, label, intervals);
    }

    if (comma === -1) {
      break;
    }
    sectionStart = comma + 1;
  }
}

function canonicalizeSet(input: PositionSet): PositionSet {
  const groups = new Map<string, PositionGroup>();
  for (const group of input.groups) {
    const sid = group.sid.toLowerCase();
    const key = groupKey(sid, group.label);
    const existing = groups.get(key);
    if (existing) {
      existing.intervals.push(...group.intervals);
    } else {
      groups.set(key, {
        sid,
        label: group.label,
        intervals: [...group.intervals],
      });
    }
  }
  return finishGroups(groups);
}

function toPositionSet(input: PositionInput): PositionSet {
  if (typeof input === "string") {
    const result = parse(input);
    if (!result.ok) {
      throw new PositionParseError(result.error, result.offset);
    }
    return result.value;
  }

  if ("ok" in input) {
    if (!input.ok) {
      throw new PositionParseError(input.error, input.offset);
    }
    return input.value;
  }

  return canonicalizeSet(input);
}

function formatInterval(interval: Interval): string {
  return interval.start === interval.end
    ? interval.start.toString()
    : `${interval.start.toString()}-${interval.end.toString()}`;
}

function formatIntervals(intervals: readonly Interval[]): string {
  return intervals.map(formatInterval).join(":");
}

export function stringify(input: PositionInput): string {
  const set = toPositionSet(input);
  return set.groups
    .map((group) =>
      group.label === null
        ? `${group.sid}:${formatIntervals(group.intervals)}`
        : `${group.sid}:${group.label}:${formatIntervals(group.intervals)}`,
    )
    .join(",");
}

export function parse(input: string): ParseResult {
  const groups = new Map<string, PositionGroup>();

  try {
    parseText(input, groups);
  } catch (error) {
    if (!(error instanceof InternalParseFailure)) {
      throw error;
    }
    const offset = byteOffset(input, error.index);
    const failure: ParseFailure = {
      ok: false,
      offset,
      error: error.message,
    };
    Object.defineProperties(failure, {
      message: { value: error.message, enumerable: false },
      byteOffset: { value: offset, enumerable: false },
    });
    return failure;
  }

  const value = finishGroups(groups);
  const success: ParseSuccess = { ok: true, value };
  Object.defineProperties(success, {
    set: { value, enumerable: false },
    groups: { value: value.groups, enumerable: false },
    text: {
      enumerable: false,
      get() {
        return stringify(value);
      },
    },
    toString: {
      enumerable: false,
      value() {
        return stringify(value);
      },
    },
  });
  return success;
}

export function normalize(input: PositionInput): string {
  return stringify(input);
}

export const canonicalize = normalize;
export const format = stringify;
export const formatSet = stringify;
export const formatPositionSet = stringify;

function findGroup(
  set: PositionSet,
  sid: string,
  label: string | null,
): PositionGroup | undefined {
  return set.groups.find(
    (group) => group.sid === sid && group.label === label,
  );
}

function intersectIntervals(
  left: readonly Interval[],
  right: readonly Interval[],
): Interval[] {
  const result: Interval[] = [];
  let i = 0;
  let j = 0;

  while (i < left.length && j < right.length) {
    const start =
      left[i].start > right[j].start ? left[i].start : right[j].start;
    const end = left[i].end < right[j].end ? left[i].end : right[j].end;

    if (start <= end) {
      result.push({ start, end });
    }

    if (left[i].end < right[j].end) {
      i += 1;
    } else if (right[j].end < left[i].end) {
      j += 1;
    } else {
      i += 1;
      j += 1;
    }
  }

  return result;
}

function subtractIntervals(
  base: readonly Interval[],
  remove: readonly Interval[],
): Interval[] {
  const result: Interval[] = [];
  let removeIndex = 0;

  for (const interval of base) {
    let cursor = interval.start;

    while (
      removeIndex < remove.length &&
      remove[removeIndex].end < cursor
    ) {
      removeIndex += 1;
    }

    let currentRemove = removeIndex;
    while (cursor <= interval.end) {
      while (
        currentRemove < remove.length &&
        remove[currentRemove].end < cursor
      ) {
        currentRemove += 1;
      }

      if (currentRemove >= remove.length) {
        result.push({ start: cursor, end: interval.end });
        break;
      }

      const removing = remove[currentRemove];
      if (removing.start > interval.end) {
        result.push({ start: cursor, end: interval.end });
        break;
      }

      if (removing.start > cursor) {
        result.push({ start: cursor, end: removing.start - 1n });
      }

      if (removing.end >= interval.end) {
        break;
      }

      cursor = removing.end + 1n;
      currentRemove += 1;
    }
  }

  return result;
}

export function union(...inputs: PositionInput[]): string {
  const groups = new Map<string, PositionGroup>();

  for (const input of inputs) {
    const set = toPositionSet(input);
    for (const group of set.groups) {
      addIntervals(groups, group.sid, group.label, group.intervals);
    }
  }

  return stringify(finishGroups(groups));
}

export function intersection(...inputs: PositionInput[]): string {
  if (inputs.length === 0) {
    return "";
  }

  const first = toPositionSet(inputs[0]);
  const others = inputs.slice(1).map(toPositionSet);
  const groups = new Map<string, PositionGroup>();

  for (const group of first.groups) {
    let intervals = group.intervals;
    let present = true;

    for (const other of others) {
      const matching = findGroup(other, group.sid, group.label);
      if (!matching) {
        present = false;
        break;
      }
      intervals = intersectIntervals(intervals, matching.intervals);
      if (intervals.length === 0) {
        present = false;
        break;
      }
    }

    if (present && intervals.length > 0) {
      groups.set(groupKey(group.sid, group.label), {
        sid: group.sid,
        label: group.label,
        intervals,
      });
    }
  }

  return stringify(finishGroups(groups));
}

export const intersect = intersection;
export const merge = union;

export function difference(
  minuend: PositionInput,
  ...subtrahends: PositionInput[]
): string {
  let groups = new Map<string, PositionGroup>();

  for (const group of toPositionSet(minuend).groups) {
    groups.set(groupKey(group.sid, group.label), {
      sid: group.sid,
      label: group.label,
      intervals: [...group.intervals],
    });
  }

  for (const subtrahend of subtrahends) {
    const removeSet = toPositionSet(subtrahend);
    const next = new Map<string, PositionGroup>();

    for (const group of groups.values()) {
      const removing = findGroup(removeSet, group.sid, group.label);
      const intervals = removing
        ? subtractIntervals(group.intervals, removing.intervals)
        : group.intervals;

      if (intervals.length > 0) {
        next.set(groupKey(group.sid, group.label), {
          sid: group.sid,
          label: group.label,
          intervals: [...intervals],
        });
      }
    }

    groups = next;
  }

  return stringify(finishGroups(groups));
}

export const subtract = difference;
export const minus = difference;

function toTransaction(value: TransactionId): bigint {
  if (typeof value === "bigint") {
    if (value < 1n || value > MAX_TRANSACTION_ID) {
      throw new RangeError(
        "transaction number must be between 1 and 9223372036854775807",
      );
    }
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(
        "transaction number must be a safe integer or bigint",
      );
    }
    return toTransaction(BigInt(value));
  }

  if (typeof value === "string") {
    if (!/^[1-9][0-9]*$/.test(value)) {
      throw new RangeError(
        "transaction number must be an unsigned decimal integer",
      );
    }
    if (
      value.length > MAX_TRANSACTION_TEXT.length ||
      (value.length === MAX_TRANSACTION_TEXT.length &&
        value > MAX_TRANSACTION_TEXT)
    ) {
      throw new RangeError("transaction number exceeds 9223372036854775807");
    }
    return BigInt(value);
  }

  throw new TypeError(
    "transaction number must be a bigint, string, or number",
  );
}

function intervalContains(interval: Interval, transaction: bigint): boolean {
  return transaction >= interval.start && transaction <= interval.end;
}

function groupContains(group: PositionGroup, transaction: bigint): boolean {
  for (const interval of group.intervals) {
    if (transaction < interval.start) {
      return false;
    }
    if (intervalContains(interval, transaction)) {
      return true;
    }
  }
  return false;
}

export function contains(
  input: PositionInput,
  transaction: TransactionId,
): boolean;
export function contains(
  input: PositionInput,
  sid: string,
  transaction: TransactionId,
): boolean;
export function contains(
  input: PositionInput,
  sid: string,
  label: string | null,
  transaction: TransactionId,
): boolean;
export function contains(
  input: PositionInput,
  sidOrTransaction: string | TransactionId,
  labelOrTransaction?: string | null | TransactionId,
  maybeTransaction?: TransactionId,
): boolean {
  const set = toPositionSet(input);

  if (maybeTransaction === undefined) {
    if (labelOrTransaction === undefined) {
      const transaction = toTransaction(sidOrTransaction as TransactionId);
      return set.groups.some((group) => groupContains(group, transaction));
    }

    const sid = String(sidOrTransaction).toLowerCase();
    const transaction = toTransaction(labelOrTransaction as TransactionId);
    return set.groups.some(
      (group) => group.sid === sid && groupContains(group, transaction),
    );
  }

  const sid = String(sidOrTransaction).toLowerCase();
  const label =
    labelOrTransaction === null || labelOrTransaction === ""
      ? null
      : String(labelOrTransaction);
  const transaction = toTransaction(maybeTransaction);
  const group = findGroup(set, sid, label);
  return group !== undefined && groupContains(group, transaction);
}

export const containsTransaction = (
  input: PositionInput,
  transaction: TransactionId,
): boolean => contains(input, transaction);
export const containsPosition = containsTransaction;

export function isSubset(
  candidate: PositionInput,
  superset: PositionInput,
): boolean {
  const candidateSet = toPositionSet(candidate);
  const supersetSet = toPositionSet(superset);

  for (const group of candidateSet.groups) {
    const covering = findGroup(supersetSet, group.sid, group.label);
    if (!covering) {
      return false;
    }

    for (const interval of group.intervals) {
      if (subtractIntervals([interval], covering.intervals).length > 0) {
        return false;
      }
    }
  }

  return true;
}

export const subset = isSubset;
export const isSubsetOf = isSubset;

export function isSuperset(
  superset: PositionInput,
  candidate: PositionInput,
): boolean {
  return isSubset(candidate, superset);
}

export function unionSets(...inputs: PositionInput[]): PositionSet {
  return toPositionSet(union(...inputs));
}

export function intersectionSets(...inputs: PositionInput[]): PositionSet {
  return toPositionSet(intersection(...inputs));
}

export function differenceSets(
  minuend: PositionInput,
  ...subtrahends: PositionInput[]
): PositionSet {
  return toPositionSet(difference(minuend, ...subtrahends));
}

export const unionSet = unionSets;
export const intersectionSet = intersectionSets;
export const differenceSet = differenceSets;

export function parsePositionSet(input: string): ParseResult {
  return parse(input);
}

export const parsePositions = parsePositionSet;

const api = {
  parse,
  parsePositionSet,
  stringify,
  normalize,
  canonicalize,
  format,
  formatSet,
  formatPositionSet,
  union,
  unionSets,
  unionSet,
  merge,
  intersection,
  intersect,
  intersectionSets,
  intersectionSet,
  difference,
  subtract,
  minus,
  differenceSets,
  differenceSet,
  contains,
  containsTransaction,
  containsPosition,
  isSubset,
  subset,
  isSubsetOf,
  isSuperset,
  parsePositions,
};

export default api;
