import { authorizationPath, classificationOf } from './policy.js';

// Verifies that every non-null output field has an authorization path for
// every audience the view is shared with. Null-valued fields are boundary
// nulls (or genuine nulls) and carry no content, so they need no grant.
export function auditViewFields(policy, audienceIds, fields) {
  const violations = [];
  const paths = {};
  const boundaryNulls = [];
  for (const [field, value] of Object.entries(fields)) {
    const fieldPaths = audienceIds.map((audienceId) => authorizationPath(policy, audienceId, field));
    if (value === null && fieldPaths.every((path) => path === null)) {
      boundaryNulls.push(field);
      continue;
    }
    if (fieldPaths.every((path) => path !== null)) {
      paths[field] = audienceIds.length === 1 ? fieldPaths[0] : fieldPaths;
    } else {
      violations.push(field);
    }
  }
  return { violations, paths, boundaryNulls };
}

// Minimal counterexample: the smallest field set that makes the supplier view
// leak recipe data. A single leaked recipe-classified field already
// constitutes a leak, so the minimal set is a singleton when one exists;
// otherwise it is the full set of unauthorized fields.
export function minimalCounterexample(policy, violations) {
  if (violations.length === 0) return null;
  const recipeLeaks = violations.filter((field) => classificationOf(policy, field) === 'recipe').sort();
  if (recipeLeaks.length > 0) return [recipeLeaks[0]];
  return [...violations].sort();
}

export function auditView(policy, audienceIds, viewFile) {
  const { violations, paths, boundaryNulls } = auditViewFields(policy, audienceIds, viewFile.fields);
  return {
    view: viewFile.fileName ?? null,
    reportId: viewFile.reportId,
    audience: viewFile.audience,
    ok: violations.length === 0,
    checked: Object.keys(viewFile.fields).length,
    violations,
    counterexample: minimalCounterexample(policy, violations),
    boundaryNulls,
    paths,
  };
}
