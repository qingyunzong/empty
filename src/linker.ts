export type ModuleId = string;

/** export { name } / export { name as as } —— 本地绑定显式导出 */
export interface LocalExportDecl {
  kind: "local";
  name: string;
  as?: string;
}

/** export { name } from 'from' / export { name as as } from 'from' —— 显式再导出 */
export interface ReExportDecl {
  kind: "reexport";
  name: string;
  as?: string;
  from: ModuleId;
}

/** export * from 'from' —— 星号导出 */
export interface StarExportDecl {
  kind: "star";
  from: ModuleId;
}

export type ExportDecl = LocalExportDecl | ReExportDecl | StarExportDecl;

export interface ModuleSpec {
  id: ModuleId;
  exports: ExportDecl[];
}

/** 绑定的规范身份：定义模块 + 本地名。同绑定多路径不歧义的判定依据。 */
export interface Binding {
  module: ModuleId;
  name: string;
}

export function bindingKey(binding: Binding): string {
  return `${binding.module}#${binding.name}`;
}

/** 一条已解析导出：来源绑定 + 从当前模块到定义模块的来源路径 */
export interface ExportInfo {
  binding: Binding;
  path: ModuleId[];
}

export interface ModuleState {
  /** 导出名 -> 解析结果（显式优先，星号补充） */
  exports: Map<string, ExportInfo>;
  /** 导出名 -> 冲突的不同绑定（星号同名来自不同绑定时记录） */
  ambiguities: Map<string, Binding[]>;
}

export interface GraphState {
  modules: Map<ModuleId, ModuleState>;
}

export interface RoundTrace {
  round: number;
  state: GraphState;
}

export interface LinkResult {
  state: GraphState;
  /** 达到固定点所用的全图合并轮数 */
  rounds: number;
  /** 逐轮全图合并的快照，用于核验 */
  trace: RoundTrace[];
}

function emptyState(specs: Map<ModuleId, ModuleSpec>): GraphState {
  const modules = new Map<ModuleId, ModuleState>();
  for (const id of specs.keys()) {
    modules.set(id, { exports: new Map(), ambiguities: new Map() });
  }
  return { modules };
}

function indexSpecs(specs: ModuleSpec[]): Map<ModuleId, ModuleSpec> {
  const byId = new Map<ModuleId, ModuleSpec>();
  for (const spec of specs) {
    if (byId.has(spec.id)) throw new Error(`duplicate module id: ${spec.id}`);
    byId.set(spec.id, spec);
  }
  return byId;
}

/**
 * 单轮全图合并：基于上一轮状态，为每个模块重算导出表。
 * 规则：
 * - 显式导出（本地/再导出，含别名 as）优先于星号导出；
 * - 星号导出同名但来自同一绑定（多路径）不歧义，保留先到的较短路径；
 * - 星号导出同名来自不同绑定时记入 ambiguities，且该名不进入导出表；
 * - 歧义记录单调累积，一旦歧义不会复活。
 */
export function mergeRound(
  specs: Map<ModuleId, ModuleSpec>,
  prev: GraphState,
): GraphState {
  const next = new Map<ModuleId, ModuleState>();

  for (const [id, spec] of specs) {
    const prevModule = prev.modules.get(id);
    if (!prevModule) throw new Error(`unknown module in state: ${id}`);

    const explicit = new Map<string, ExportInfo>();
    const star = new Map<string, ExportInfo>();
    const ambiguities = new Map<string, Binding[]>();
    for (const [name, bindings] of prevModule.ambiguities) {
      ambiguities.set(name, bindings.map((b) => ({ ...b })));
    }

    const noteAmbiguity = (name: string, binding: Binding): void => {
      const existing = ambiguities.get(name);
      if (existing) {
        if (!existing.some((b) => bindingKey(b) === bindingKey(binding))) {
          existing.push({ ...binding });
        }
      } else {
        const prior = star.get(name);
        const bindings: Binding[] = [];
        if (prior) bindings.push({ ...prior.binding });
        bindings.push({ ...binding });
        ambiguities.set(name, bindings);
        star.delete(name);
      }
    };

    // 1) 显式导出：本地绑定与再导出（含别名），同名取先声明者。
    for (const decl of spec.exports) {
      if (decl.kind === "local") {
        const exported = decl.as ?? decl.name;
        if (!explicit.has(exported)) {
          explicit.set(exported, {
            binding: { module: id, name: decl.name },
            path: [id],
          });
        }
      } else if (decl.kind === "reexport") {
        const exported = decl.as ?? decl.name;
        const target = prev.modules.get(decl.from)?.exports.get(decl.name);
        if (target && !explicit.has(exported)) {
          explicit.set(exported, {
            binding: { ...target.binding },
            path: [id, ...target.path],
          });
        }
      }
    }

    // 2) 星号导出：显式优先；同绑定多路径不歧义；不同绑定报歧义。
    for (const decl of spec.exports) {
      if (decl.kind !== "star") continue;
      const fromState = prev.modules.get(decl.from);
      if (!fromState) continue;
      for (const [name, info] of fromState.exports) {
        if (explicit.has(name)) continue;
        if (ambiguities.has(name)) {
          noteAmbiguity(name, info.binding);
          continue;
        }
        const prior = star.get(name);
        if (!prior) {
          star.set(name, {
            binding: { ...info.binding },
            path: [id, ...info.path],
          });
        } else if (bindingKey(prior.binding) !== bindingKey(info.binding)) {
          noteAmbiguity(name, info.binding);
        }
        // 同绑定多路径：保留先到的（轮次单调，路径不更长），不歧义。
      }
    }

    const exports = new Map<string, ExportInfo>(explicit);
    for (const [name, info] of star) exports.set(name, info);
    next.set(id, { exports, ambiguities });
  }

  return { modules: next };
}

function moduleStateEquals(a: ModuleState, b: ModuleState): boolean {
  if (a.exports.size !== b.exports.size) return false;
  for (const [name, info] of a.exports) {
    const other = b.exports.get(name);
    if (!other) return false;
    if (bindingKey(info.binding) !== bindingKey(other.binding)) return false;
    if (info.path.join(">") !== other.path.join(">")) return false;
  }
  if (a.ambiguities.size !== b.ambiguities.size) return false;
  for (const [name, bindings] of a.ambiguities) {
    const other = b.ambiguities.get(name);
    if (!other) return false;
    const keys = (bs: Binding[]) => bs.map(bindingKey).sort().join("|");
    if (keys(bindings) !== keys(other)) return false;
  }
  return true;
}

export function graphStateEquals(a: GraphState, b: GraphState): boolean {
  if (a.modules.size !== b.modules.size) return false;
  for (const [id, state] of a.modules) {
    const other = b.modules.get(id);
    if (!other || !moduleStateEquals(state, other)) return false;
  }
  return true;
}

/**
 * 逐轮全图合并直至固定点。每轮用上一轮状态整体重算全图，
 * 状态关于"可解析知识"单调且有界，故循环模块图必收敛。
 */
export function link(specs: ModuleSpec[], maxRounds = 10_000): LinkResult {
  const byId = indexSpecs(specs);
  let state = emptyState(byId);
  const trace: RoundTrace[] = [];
  for (let round = 1; round <= maxRounds; round++) {
    const next = mergeRound(byId, state);
    trace.push({ round, state: next });
    if (graphStateEquals(next, state)) {
      return { state: next, rounds: round, trace };
    }
    state = next;
  }
  throw new Error(`link did not converge within ${maxRounds} rounds`);
}

/** 固定点核验：对结果再做一轮全图合并，状态必须不变。 */
export function verifyFixedPoint(specs: ModuleSpec[], result: LinkResult): boolean {
  const byId = indexSpecs(specs);
  return graphStateEquals(mergeRound(byId, result.state), result.state);
}

/**
 * 参考实现（核验用）：同一不动点系统的 Gauss-Seidel 式就地迭代，
 * 与逐轮同步全图合并的求值次序不同，但最小不动点一致。
 */
export function referenceLink(specs: ModuleSpec[]): GraphState {
  const byId = indexSpecs(specs);
  let state = emptyState(byId);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [id] of byId) {
      const single = new Map([[id, byId.get(id)!]]);
      const merged = mergeRound(single, state);
      const before = state.modules.get(id)!;
      const after = merged.modules.get(id)!;
      if (!moduleStateEquals(before, after)) {
        state.modules.set(id, after);
        changed = true;
      }
    }
  }
  return state;
}

/** 输出每个模块的导出表：导出名、来源绑定与来源路径，以及歧义报告。 */
export function formatLinkResult(result: LinkResult): string {
  const lines: string[] = [];
  lines.push(`converged in ${result.rounds} round(s)`);
  for (const [id, state] of [...result.state.modules.entries()].sort()) {
    lines.push(`module ${id}:`);
    for (const [name, info] of [...state.exports.entries()].sort()) {
      lines.push(
        `  export ${name} <= ${bindingKey(info.binding)} (path: ${info.path.join(" -> ")})`,
      );
    }
    for (const [name, bindings] of [...state.ambiguities.entries()].sort()) {
      lines.push(
        `  ! ambiguous ${name}: ${bindings.map(bindingKey).join(" vs ")}`,
      );
    }
  }
  return lines.join("\n");
}
