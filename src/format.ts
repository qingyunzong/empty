import type { Diagnostic, LinkResult, ResolvedExport } from "./linker";

function formatOrigin(info: ResolvedExport): string {
  return `${info.origin.module}#${info.origin.name}`;
}

function formatDiagnostic(diag: Diagnostic): string {
  switch (diag.type) {
    case "ambiguous-star-export": {
      const origins = diag.origins.map((o) => `${o.module}#${o.name}`).join(", ");
      return `[ambiguous-star-export] ${diag.module}: "${diag.name}" ` +
        `resolves to multiple bindings (${origins}) via ${diag.sources.join(", ")}`;
    }
    case "unresolved-reexport":
      return `[unresolved-reexport] ${diag.module}: ` +
        `"${diag.importedName}" is not exported by ${diag.source} ` +
        `(re-exported as "${diag.exportedName}")`;
    case "unknown-module":
      return `[unknown-module] ${diag.module}: cannot resolve module ${diag.source}`;
  }
}

/** Human-readable report: per-module exports with their source paths. */
export function formatReport(result: LinkResult, moduleOrder?: string[]): string {
  const lines: string[] = [];
  const paths = moduleOrder ?? [...result.exports.keys()].sort();
  for (const mod of paths) {
    const entries = result.exports.get(mod);
    if (!entries) continue;
    lines.push(`== ${mod} ==`);
    for (const info of [...entries.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`  ${info.name} -> ${formatOrigin(info)} (via ${info.path.join(" > ")})`);
    }
    if (entries.size === 0) lines.push("  (no exports)");
  }
  if (result.diagnostics.length > 0) {
    lines.push("Diagnostics:");
    for (const diag of result.diagnostics) {
      lines.push(`  ${formatDiagnostic(diag)}`);
    }
  }
  lines.push(`converged in ${result.rounds} round(s)`);
  return lines.join("\n");
}
