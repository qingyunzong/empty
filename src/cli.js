import { check, plan, repair, merge, explain, createBaseVersion } from './index.js';
import { badInput } from './errors.js';

export const COMMANDS = ['check', 'plan', 'repair', 'merge', 'explain', 'init'];

export const USAGE = `usage: dq <command> [input.json]   (JSON is read from stdin when no file is given)

commands:
  check    {data|version, rules}                        -> {ok, order, violations}
  plan     {data|version, schema, rules, budget?, maxPlans?, maxStates?}
           -> {plans, best, states, budget}  (plans ranked: resolved desc, cost asc, hash asc)
  repair   {version, schema, rules, budget?, node?}     -> {version, plan} (new causal successor)
  merge    {base, a, b, node?}                          -> {version, relation}
  explain  {versions, target}                           -> {steps, final, matches}
  init     {data, node?}                                -> {version} (base version)

error codes: RULE_CYCLE, NO_FEASIBLE, HISTORY_CONFLICT, SEARCH_LIMIT, BAD_INPUT`;

// Dispatch a command to the library. Throws DqError on failure.
export function runCommand(command, input) {
  switch (command) {
    case 'check':
      return check(input);
    case 'plan':
      return plan(input);
    case 'repair':
      return repair(input);
    case 'merge':
      return merge(input);
    case 'explain':
      return explain(input.versions, input.target);
    case 'init':
      return { version: createBaseVersion(input.data, input.node) };
    default:
      throw badInput(`unknown command: ${command}`);
  }
}
