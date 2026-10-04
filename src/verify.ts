import {
  ConflictPair,
  FIELDS,
  FieldEvidence,
  ItemReport,
  Report,
  SOURCES,
} from "./model.js";
import { loadSource, ParsedSource } from "./parse.js";

/**
 * Minimal conflict pairs: group the present values per field; for every
 * unordered pair of distinct value-groups emit exactly one representative
 * citation pair. This is the smallest complete witness set: removing any
 * pair would leave two disagreeing groups without evidence of their
 * contradiction, and no pair cites equal values.
 */
export function minimalConflictPairs(
  field: (typeof FIELDS)[number],
  evidences: FieldEvidence[]
): ConflictPair[] {
  const groups = new Map<string, FieldEvidence[]>();
  for (const ev of evidences) {
    const g = groups.get(ev.value);
    if (g) g.push(ev);
    else groups.set(ev.value, [ev]);
  }
  const reps = [...groups.values()].map((g) => g[0]!);
  const pairs: ConflictPair[] = [];
  for (let i = 0; i < reps.length; i++) {
    for (let j = i + 1; j < reps.length; j++) {
      pairs.push({ field, a: reps[i]!, b: reps[j]! });
    }
  }
  return pairs;
}

export function verifyDataset(dir: string): Report {
  const sources: ParsedSource[] = SOURCES.map((s) => loadSource(dir, s));
  const datasetIssues = sources.flatMap((s) => s.issues);

  const itemIds = new Set<string>();
  for (const s of sources) for (const id of s.records.keys()) itemIds.add(id);

  const items: ItemReport[] = [];
  for (const itemId of [...itemIds].sort()) {
    const present = sources.filter((s) => s.records.has(itemId));
    const missing = sources.filter((s) => !s.records.has(itemId));
    const report: ItemReport = {
      itemId,
      status: "consistent",
      presentIn: present.map((s) => s.source),
      missingFrom: missing.map((s) => s.source),
      conflictPairs: [],
      issues: [],
    };

    for (const src of missing) {
      report.issues.push({
        kind: "missing-item",
        itemId,
        field: null,
        message: `item missing from ${src.source} (缺失证据)`,
        citations: present.map((p) => p.records.get(itemId)!.citation),
      });
    }

    for (const field of FIELDS) {
      const evidences: FieldEvidence[] = [];
      for (const src of present) {
        const rec = src.records.get(itemId)!;
        const f = rec.fields.get(field);
        if (f) {
          evidences.push(f);
        } else {
          report.issues.push({
            kind: "missing-field",
            itemId,
            field,
            message: `field "${field}" missing in ${src.source} (缺失证据)`,
            citations: [rec.citation],
          });
        }
      }
      const pairs = minimalConflictPairs(field, evidences);
      for (const pair of pairs) {
        report.issues.push({
          kind: "value-mismatch",
          itemId,
          field,
          message:
            `conflicting "${field}": ` +
            `${pair.a.citation.source}=${JSON.stringify(pair.a.value)} vs ` +
            `${pair.b.citation.source}=${JSON.stringify(pair.b.value)} (矛盾)`,
          citations: [pair.a.citation, pair.b.citation],
        });
      }
      report.conflictPairs.push(...pairs);
    }

    if (report.conflictPairs.length > 0) report.status = "conflict";
    else if (report.issues.length > 0) report.status = "unknown";
    items.push(report);
  }

  const summary = { total: items.length, consistent: 0, unknown: 0, conflict: 0 };
  for (const it of items) summary[it.status]++;
  // Dataset-level contradictions (duplicates) force conflict visibility.
  return { items, issues: datasetIssues, summary };
}

/** Exit code policy: 1 = any 矛盾, 2 = only 未知, 0 = fully consistent. */
export function exitCodeFor(report: Report): number {
  if (report.summary.conflict > 0) return 1;
  if (report.issues.some((i) => i.kind === "duplicate-record")) return 1;
  if (report.summary.unknown > 0 || report.issues.length > 0) return 2;
  return 0;
}
