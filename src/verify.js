import { nonEquiv } from './errors.js';
import { execLogical } from './exec.js';
import { hashResult } from './hash.js';

const PLAN_NODE_TYPES = new Set(['scan', 'select', 'project', 'join', 'groupby', 'aggpartial', 'aggfinal']);

export function validatePlanShape(node, path = 'plan') {
  if (!node || typeof node !== 'object' || !PLAN_NODE_TYPES.has(node.type)) {
    throw nonEquiv(`invalid plan node at ${path}: unknown type ${node && node.type}`);
  }
  switch (node.type) {
    case 'scan':
      if (typeof node.table !== 'string' || typeof node.alias !== 'string' || !Array.isArray(node.columns)) {
        throw nonEquiv(`invalid scan node at ${path}`);
      }
      break;
    case 'select':
      if (!node.predicate) throw nonEquiv(`select node at ${path} missing predicate`);
      validatePlanShape(node.input, `${path}.input`);
      break;
    case 'project':
      if (!Array.isArray(node.items)) throw nonEquiv(`project node at ${path} missing items`);
      validatePlanShape(node.input, `${path}.input`);
      break;
    case 'join':
      if (!Array.isArray(node.leftKeys) || !Array.isArray(node.rightKeys)) throw nonEquiv(`join node at ${path} missing keys`);
      validatePlanShape(node.left, `${path}.left`);
      validatePlanShape(node.right, `${path}.right`);
      break;
    case 'groupby':
    case 'aggfinal':
      if (!Array.isArray(node.keys) || !Array.isArray(node.aggs)) throw nonEquiv(`${node.type} node at ${path} malformed`);
      validatePlanShape(node.input, `${path}.input`);
      break;
    case 'aggpartial':
      if (!Array.isArray(node.keys) || !Array.isArray(node.aggs)) throw nonEquiv(`aggpartial node at ${path} malformed`);
      validatePlanShape(node.input, `${path}.input`);
      break;
    default:
      break;
  }
}

// Structural re-check of every claimed rewrite rule's preconditions.
// A rewrite that violates its preconditions is rejected, never approximated.
export function validateCertificateRules(rules) {
  const DECOMPOSABLE = new Set(['count', 'sum', 'min', 'max', 'avg']);
  for (const r of rules ?? []) {
    if (r.rule === 'predicate_pushdown') {
      const { refs = [], targetSchema = [] } = r.detail ?? {};
      for (const ref of refs) {
        if (!targetSchema.includes(ref)) {
          throw nonEquiv(`predicate_pushdown precondition violated: column ${ref} is not in the target subtree schema`);
        }
      }
    } else if (r.rule === 'aggregate_pushdown') {
      for (const f of r.detail?.aggregates ?? []) {
        if (!DECOMPOSABLE.has(f)) {
          throw nonEquiv(`aggregate_pushdown precondition violated: ${f} is not decomposable`);
        }
      }
    } else if (r.rule === 'projection_pruning') {
      const { pruned = [], retained = [] } = r.detail ?? {};
      for (const c of pruned) {
        if (retained.includes(c)) throw nonEquiv(`projection_pruning precondition violated: ${c} both pruned and retained`);
      }
    } else {
      throw nonEquiv(`unknown rewrite rule in certificate: ${r.rule}`);
    }
  }
}

// Exact equivalence check on the loaded data: full result multiset hashes,
// including the HAVING-unknown bucket. Any mismatch -> E_NON_EQUIV.
export function verifyPlans(planA, planB, ctx) {
  validatePlanShape(planA, 'planA');
  validatePlanShape(planB, 'planB');
  const resA = execLogical(planA, ctx);
  const resB = execLogical(planB, ctx);
  const hashA = hashResult(resA);
  const hashB = hashResult(resB);
  if (hashA !== hashB) {
    throw nonEquiv(
      `plans are not equivalent on the loaded data: ` +
      `${hashA.slice(0, 16)}… != ${hashB.slice(0, 16)}… ` +
      `(${resA.rows.length}+${resA.unknown.length}u vs ${resB.rows.length}+${resB.unknown.length}u rows)`);
  }
  return { equivalent: true, hash: hashA, rows: resA.rows.length, unknownRows: resA.unknown.length };
}
