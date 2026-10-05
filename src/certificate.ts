/** Independent checker for derivation certificates produced by the parser. */

import type { Grammar, Rule } from "./grammar.ts";
import type { Certificate } from "./parse.ts";
import type { Tree } from "./tree.ts";

export type VerifyResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Replays a certificate against the grammar and input tree, checking that
 *   - every rule id exists and is applied at a node labelled with its symbol,
 *   - child nonterminals chain correctly down to the leaves,
 *   - the root rule rewrites the start nonterminal,
 *   - the rule ids are consumed exactly (preorder, no gaps or extras),
 *   - the claimed cost equals the sum of the applied rule costs.
 * Optimality itself is certified by the DP; this checker certifies validity.
 */
export function verifyCertificate(grammar: Grammar, root: Tree, certificate: Certificate): VerifyResult {
  const ruleById = new Map<number, Rule>(grammar.rules.map((rule) => [rule.id, rule]));
  let pos = 0;
  let total = 0;
  let failure: string | null = null;

  const walk = (node: Tree, nonterminal: string, path: string): void => {
    if (failure !== null) return;
    if (pos >= certificate.ruleIds.length) {
      failure = `ran out of rule ids at node ${path}`;
      return;
    }
    const id = certificate.ruleIds[pos];
    pos += 1;
    const rule = ruleById.get(id);
    if (rule === undefined) {
      failure = `unknown rule id ${id} at node ${path}`;
      return;
    }
    if (rule.lhs !== nonterminal) {
      failure = `rule ${id} rewrites ${JSON.stringify(rule.lhs)}, expected ${JSON.stringify(nonterminal)} at node ${path}`;
      return;
    }
    if (rule.symbol !== node.symbol) {
      failure = `rule ${id} derives symbol ${JSON.stringify(rule.symbol)} but node ${path} is labelled ${JSON.stringify(node.symbol)}`;
      return;
    }
    if (rule.children.length !== node.children.length) {
      failure = `rule ${id} has ${rule.children.length} children but node ${path} has ${node.children.length}`;
      return;
    }
    total += rule.cost;
    for (let k = 0; k < rule.children.length; k += 1) {
      walk(node.children[k], rule.children[k], `${path}/${k}`);
    }
  };

  walk(root, grammar.start, "$");
  if (failure !== null) return { ok: false, reason: failure };
  if (pos !== certificate.ruleIds.length) {
    return { ok: false, reason: `${certificate.ruleIds.length - pos} unused rule id(s) at the end` };
  }
  if (total !== certificate.cost) {
    return { ok: false, reason: `claimed cost ${certificate.cost} but applied rules sum to ${total}` };
  }
  return { ok: true };
}
