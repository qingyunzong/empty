import { canonicalRowOrder, rowKey } from './canonical.ts';
import type {
  DirectedEdge,
  JoinInput,
  JoinPlan,
  ReductionReport,
  ReductionResult,
  ReductionStep,
  Row,
  RowReport,
} from './types.ts';
import { buildPlan } from './plan.ts';

interface RowState {
  row: Row;
  alive: boolean;
  firstDeletedBy?: DirectedEdge;
  missingKey?: Partial<Record<string, bigint | string>>;
}

function semiJoin(
  states: Map<string, RowState[]>,
  plan: JoinPlan,
  from: string,
  to: string,
  pass: 'postorder' | 'preorder',
  steps: ReductionStep[],
): void {
  const shared = plan.attributes[from].filter((attribute) =>
    plan.attributes[to].includes(attribute),
  );

  const sourceRows = states.get(from)!.filter((state) => state.alive);
  let projected: Set<string>;
  let projectionHasRows: boolean;
  if (shared.length === 0) {
    projected = new Set();
    projectionHasRows = sourceRows.length > 0;
  } else {
    projected = new Set(sourceRows.map((state) => rowKey(state.row, shared)));
    projectionHasRows = projected.size > 0;
  }

  let deletedCount = 0;
  for (const state of states.get(to)!) {
    if (!state.alive) {
      continue;
    }
    let survives: boolean;
    if (shared.length === 0) {
      survives = projectionHasRows;
    } else {
      survives = projected.has(rowKey(state.row, shared));
    }
    if (!survives) {
      state.alive = false;
      const edge: DirectedEdge = { from, to };
      state.firstDeletedBy = edge;
      const missingKey: Partial<Record<string, bigint | string>> = {};
      for (const attribute of shared) {
        missingKey[attribute] = state.row[attribute];
      }
      state.missingKey = missingKey;
      deletedCount += 1;
    }
  }

  steps.push({
    from,
    to,
    pass,
    sharedAttributes: shared,
    deletedCount,
  });
}

export function reduceJoin(input: JoinInput): ReductionResult {
  const plan: JoinPlan = buildPlan(input);
  const inputByName = new Map(input.relations.map((relation) => [relation.name, relation]));
  const states = new Map<string, RowState[]>();

  for (const name of plan.relations) {
    const relation = inputByName.get(name)!;
    const canonicalAttributes = plan.attributes[name];
    const distinct = new Map<string, Row>();
    for (const row of relation.rows) {
      distinct.set(rowKey(row, canonicalAttributes), row);
    }
    const ordered = canonicalRowOrder([...distinct.values()], canonicalAttributes);
    states.set(
      name,
      ordered.map((row): RowState => ({ row, alive: true })),
    );
  }

  const steps: ReductionStep[] = [];

  for (const node of plan.postorder) {
    if (plan.parent[node] !== null) {
      semiJoin(states, plan, node, plan.parent[node]!, 'postorder', steps);
    }
  }

  for (const node of plan.preorder) {
    for (const child of plan.children[node]) {
      semiJoin(states, plan, node, child, 'preorder', steps);
    }
  }

  const reduced: Record<string, Row[]> = {};
  const reports: Record<string, ReductionReport> = {};
  let isEmpty = false;

  for (const name of plan.relations) {
    const relationStates = states.get(name)!;
    const rowReports: RowReport[] = relationStates.map((state) => {
      const report: RowReport = { row: state.row, alive: state.alive };
      if (state.firstDeletedBy !== undefined) {
        report.firstDeletedBy = state.firstDeletedBy;
      }
      if (state.missingKey !== undefined) {
        report.missingKey = state.missingKey;
      }
      return report;
    });
    const survivingRows = relationStates
      .filter((state) => state.alive)
      .map((state) => state.row);
    if (survivingRows.length === 0) {
      isEmpty = true;
    }
    reduced[name] = survivingRows;
    reports[name] = {
      relation: name,
      attributes: plan.attributes[name],
      rowReports,
      survivingRows,
    };
  }

  return {
    plan,
    digest: plan.digest,
    reduced,
    reports,
    steps,
    isEmpty,
  };
}
