import { Citation, Report } from "./model.js";

export function formatCitation(c: Citation): string {
  return `${c.file}:${c.line}:${c.colStart}-${c.colEnd}`;
}

export function formatText(report: Report): string {
  const out: string[] = [];
  for (const issue of report.issues) {
    const refs = issue.citations.map(formatCitation).join(", ");
    out.push(
      `[dataset] ${issue.kind} ${issue.message}${refs ? ` @ ${refs}` : ""}`
    );
  }
  for (const item of report.items) {
    out.push(
      `[${item.status}] ${item.itemId} ` +
        `(present: ${item.presentIn.join(",") || "-"}; ` +
        `missing: ${item.missingFrom.join(",") || "-"})`
    );
    for (const issue of item.issues) {
      const refs = issue.citations.map(formatCitation).join(", ");
      out.push(`  - ${issue.kind}: ${issue.message}${refs ? ` @ ${refs}` : ""}`);
    }
    if (item.conflictPairs.length > 0) {
      out.push(`  minimal conflict pairs (最小冲突对):`);
      for (const p of item.conflictPairs) {
        out.push(
          `  * ${p.field}: ${formatCitation(p.a.citation)} <-> ${formatCitation(p.b.citation)}`
        );
      }
    }
  }
  const s = report.summary;
  out.push(
    `summary: total=${s.total} consistent=${s.consistent} unknown=${s.unknown} conflict=${s.conflict}`
  );
  return out.join("\n") + "\n";
}
