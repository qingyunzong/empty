import { tokenize } from './lexer.js';
import { parse } from './parser.js';
import { checkRule } from './types.js';
import { compile } from './compiler.js';
import { run } from './vm.js';
import { parseSamples, contextFor } from './samples.js';
import {
  emptyChain, appendCert, hashRule, hashSamples, verifyChain,
} from './ledger.js';
import { InputError } from './errors.js';

export function compileRule(sourceText, filename) {
  const tokens = tokenize(sourceText, filename);
  const ast = parse(tokens, filename);
  checkRule(ast, filename);
  const program = compile(ast);
  return { ast, program, ruleHash: hashRule(sourceText) };
}

// Decides every version of the sample set and appends any missing
// certificates to the chain. Existing certificates are re-validated
// against the recomputed sample history so tampering is detected.
export function decide({ ruleSource, ruleFilename, samplesText, samplesFilename, chain, draft = false }) {
  const { program, ruleHash, ast } = compileRule(ruleSource, ruleFilename);
  const { versions } = parseSamples(samplesText, samplesFilename);

  if (!chain) {
    chain = emptyChain(ruleHash, ast.name, ast.ruleVersion);
  } else {
    if (chain.ruleHash !== ruleHash) {
      throw new InputError(
        `rule hash mismatch: the certificate chain was issued for a different rule ` +
        `(chain ${chain.ruleHash.slice(0, 12)}..., rule ${ruleHash.slice(0, 12)}...)`,
      );
    }
    const integrity = verifyChain(chain);
    if (!integrity.ok) {
      throw new InputError(`existing certificate chain is corrupted: ${integrity.errors.join('; ')}`);
    }
    if (chain.certs.length > versions.length) {
      throw new InputError(
        `sample history diverges: chain has ${chain.certs.length} certified versions ` +
        `but the samples file only yields ${versions.length}`,
      );
    }
  }

  const issued = [];
  versions.forEach((state, idx) => {
    const version = idx + 1;
    const sampleHash = hashSamples(state);
    const existing = chain.certs[idx];
    if (existing) {
      if (existing.version !== version || existing.sampleHash !== sampleHash) {
        throw new InputError(
          `sample history diverges at version ${version}: ` +
          `certified sample hash ${existing.sampleHash.slice(0, 12)}... != recomputed ${sampleHash.slice(0, 12)}...`,
        );
      }
      return;
    }
    const decision = run(program, contextFor(state));
    const cert = appendCert(chain, {
      version,
      decision,
      sampleHash,
      status: draft ? 'DRAFT' : 'ACTIVE',
    });
    issued.push(cert);
  });

  return { chain, issued, program, ruleHash };
}
