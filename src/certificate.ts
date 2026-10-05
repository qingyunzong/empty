import { CompiledGrammar, GrammarInput, compileGrammar } from './grammar';
import { RuleNode, TreeNode, isRuleNode, preorderRuleIds, treeYield } from './tree';

/**
 * A derivation certificate: everything needed for an independent checker to
 * confirm that `ruleIds` is a valid leftmost derivation of `sequence` from
 * `start`, with the claimed total cost. (Optimality itself is established by
 * the solver's exact DP and cross-checked exhaustively on small grammars in
 * the test-suite; the certificate proves the derivation and its cost.)
 */
export interface Certificate {
  start: string;
  sequence: string[];
  cost: number;
  /** Preorder rule IDs = leftmost derivation. */
  ruleIds: number[];
  tree: RuleNode;
}

export type VerificationResult =
  | { ok: true }
  | { ok: false; reason: string };

function verifyAgainst(
  grammar: CompiledGrammar,
  cert: Certificate,
): VerificationResult {
  const fail = (reason: string): VerificationResult => ({ ok: false, reason });

  if (cert === null || typeof cert !== 'object') return fail('certificate must be an object');
  if (cert.start !== grammar.start) {
    return fail(`certificate start '${String(cert.start)}' != grammar start '${grammar.start}'`);
  }
  if (!Array.isArray(cert.sequence)) return fail('certificate.sequence must be an array');
  if (typeof cert.cost !== 'number' || !Number.isFinite(cert.cost) || cert.cost < 0) {
    return fail('certificate.cost must be a non-negative finite number');
  }
  if (!Array.isArray(cert.ruleIds) || cert.ruleIds.some((id) => !Number.isInteger(id))) {
    return fail('certificate.ruleIds must be an array of integer rule ids');
  }
  if (cert.tree === null || typeof cert.tree !== 'object') return fail('certificate.tree is missing');

  // Structural check: every node applies a rule whose lhs matches the node
  // symbol and whose rhs exactly matches the children.
  const checkNode = (node: TreeNode, expectedNt: string): string | null => {
    if (!isRuleNode(node)) return `expected nonterminal '${expectedNt}', found a terminal leaf`;
    if (node.symbol !== expectedNt) {
      return `node symbol '${String(node.symbol)}' != expected '${expectedNt}'`;
    }
    const rule = grammar.ruleById.get(node.ruleId);
    if (!rule) return `unknown rule id ${String(node.ruleId)}`;
    if (rule.lhs !== node.symbol) {
      return `rule ${rule.id} has lhs '${rule.lhs}' but node claims '${node.symbol}'`;
    }
    if (!Array.isArray(node.children) || node.children.length !== rule.rhs.length) {
      return `rule ${rule.id} expects ${rule.rhs.length} children, node has ${
        Array.isArray(node.children) ? node.children.length : 'none'
      }`;
    }
    for (let idx = 0; idx < rule.rhs.length; idx++) {
      const sym = rule.rhs[idx]!;
      const child = node.children[idx]!;
      if (sym.kind === 'terminal') {
        if (isRuleNode(child) || child.terminal !== sym.value) {
          return `child ${idx} of rule ${rule.id} must be terminal '${sym.value}'`;
        }
      } else {
        const err = checkNode(child, sym.value);
        if (err) return err;
      }
    }
    return null;
  };

  const structuralError = checkNode(cert.tree, grammar.start);
  if (structuralError) return fail(`invalid parse tree: ${structuralError}`);

  // Yield check: leaves, read left to right, must equal the claimed sequence.
  const actualYield = treeYield(cert.tree);
  if (
    actualYield.length !== cert.sequence.length ||
    actualYield.some((tok, idx) => tok !== cert.sequence[idx])
  ) {
    return fail(
      `tree yield [${actualYield.join(' ')}] != certificate sequence [${cert.sequence.join(' ')}]`,
    );
  }

  // Derivation check: preorder rule IDs of the tree must equal ruleIds.
  const actualRuleIds = preorderRuleIds(cert.tree);
  if (
    actualRuleIds.length !== cert.ruleIds.length ||
    actualRuleIds.some((id, idx) => id !== cert.ruleIds[idx])
  ) {
    return fail('certificate.ruleIds is not the preorder (leftmost derivation) of the tree');
  }

  // Cost check: sum of applied rule costs must equal the claimed cost.
  let total = 0;
  for (const id of actualRuleIds) total += grammar.ruleById.get(id)!.cost;
  if (total !== cert.cost) {
    return fail(`claimed cost ${cert.cost} != sum of rule costs ${total}`);
  }

  return { ok: true };
}

/**
 * Independently verify a derivation certificate against a grammar.
 * Checks: tree well-formedness w.r.t. the rules, yield == sequence,
 * ruleIds == leftmost derivation, and cost == sum of rule costs.
 */
export function verifyCertificate(
  grammarInput: GrammarInput,
  cert: Certificate,
): VerificationResult {
  const grammar = compileGrammar(grammarInput);
  return verifyAgainst(grammar, cert);
}
