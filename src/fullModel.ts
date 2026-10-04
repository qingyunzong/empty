import { makeRecord, type ModuleRecord } from "./compiler.js";
import { analyzeSccs, moduleArtifact } from "./scc.js";

/**
 * Full-compilation model: compiles every module from scratch with no cache.
 * Used as the ground truth that the incremental engine is checked against.
 */
export function fullCompile(sources: Map<string, string>): Map<string, string> {
  const records = new Map<string, ModuleRecord>();
  for (const [name, source] of sources) {
    records.set(name, makeRecord(name, source));
  }
  const artifacts = new Map<string, string>();
  for (const info of analyzeSccs(records)) {
    for (const member of info.members) {
      artifacts.set(member, moduleArtifact(info.artifactHash, member));
    }
  }
  return artifacts;
}
