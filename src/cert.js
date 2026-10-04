import { hashValue } from './util.js';
import { parseSource } from './parser.js';
import { compile } from './compiler.js';
import { execute } from './vm.js';
import { LineageGraph } from './graph.js';

const REQUIRED_FIELDS = [
  'query',
  'commandHash',
  'graphVersion',
  'resultKind',
  'result',
  'paths',
  'pathHashes',
  'hash',
];

export function verifyCertificate(cert, state) {
  const errors = [];
  if (cert === null || typeof cert !== 'object' || Array.isArray(cert)) {
    return { ok: false, errors: ['certificate must be an object'] };
  }
  for (const field of REQUIRED_FIELDS) {
    if (!(field in cert)) errors.push(`missing field '${field}'`);
  }
  if (errors.length > 0) return { ok: false, errors };

  if (!Array.isArray(cert.paths) || !Array.isArray(cert.pathHashes)) {
    errors.push("'paths' and 'pathHashes' must be arrays");
  } else if (cert.paths.length !== cert.pathHashes.length) {
    errors.push("'paths' and 'pathHashes' length mismatch");
  } else {
    for (let i = 0; i < cert.paths.length; i++) {
      if (hashValue(cert.paths[i]) !== cert.pathHashes[i]) {
        errors.push(`path ${i} hash mismatch`);
      }
    }
  }

  const body = {
    query: cert.query,
    commandHash: cert.commandHash,
    graphVersion: cert.graphVersion,
    resultKind: cert.resultKind,
    result: cert.result,
    pathHashes: cert.pathHashes,
  };
  if (typeof cert.program === 'string') {
    body.program = cert.program;
    body.statementIndex = cert.statementIndex;
  }
  if (hashValue(body) !== cert.hash) errors.push('certificate hash mismatch');

  if (state) {
    if (cert.commandHash !== state.commandHash) {
      errors.push('command hash does not match the graph state');
    }
    if (cert.graphVersion !== state.version) {
      errors.push(`graph version mismatch: certificate ${cert.graphVersion}, state ${state.version}`);
    }
    let graph;
    try {
      graph = LineageGraph.fromJSON(state);
    } catch (err) {
      errors.push(`invalid graph state: ${err.message}`);
      return { ok: false, errors };
    }
    if (Array.isArray(cert.paths)) {
      for (const path of cert.paths) {
        if (!Array.isArray(path) || path.length === 0) {
          errors.push('invalid path entry');
          continue;
        }
        for (let i = 0; i < path.length; i++) {
          if (!graph.hasNode(path[i])) {
            errors.push(`path references unknown node '${path[i]}'`);
            break;
          }
          if (i + 1 < path.length && !graph.out.get(path[i]).has(path[i + 1])) {
            errors.push(`path has missing edge ${path[i]} -> ${path[i + 1]}`);
            break;
          }
        }
      }
    }
    try {
      const source = typeof cert.program === 'string' ? cert.program : cert.query;
      const index = typeof cert.program === 'string' ? cert.statementIndex : 0;
      const compiled = compile(parseSource(source));
      const { results } = execute(compiled, graph, source);
      const got = results[index];
      if (!got || JSON.stringify(got.result) !== JSON.stringify(cert.result)) {
        errors.push('re-executed query result differs from the certificate');
      }
    } catch (err) {
      errors.push(`query re-execution failed: ${err.message}`);
    }
  }
  return { ok: errors.length === 0, errors };
}
