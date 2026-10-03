import { createHash } from 'node:crypto';
import { compileSource } from './compiler.js';
import { VM, normalizeOrder } from './vm.js';
import { conserveError } from './errors.js';

export function hashSource(source) {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

export function buildCertificate(program, source, order, result) {
  return {
    version: 1,
    contract: { name: program.name, sha256: hashSource(source) },
    order: {
      id: order.id,
      type: order.type,
      amount: order.amount.toDecimal(),
      ...(order.shares ? { shares: order.shares.toDecimal() } : {}),
      overrides: Object.fromEntries(
        [...order.overrides.entries()].map(([k, v]) => [k, `${v.value.toDecimal()} ${v.type === 'money' ? program.currency : v.type}`])
      ),
    },
    matchedTiers: result.matchedTiers,
    candidates: result.candidates,
    ties: result.ties,
    exactFee: result.exactFee,
    totalFee: result.totalFee,
    residual: result.residual,
    residualAccount: result.residualAccount,
    steps: result.steps,
    conservation: {
      identity: 'totalFee + residual == exactFee',
      totalFee: result.totalFee,
      residual: result.residual,
      exactFee: result.exactFee,
    },
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Replay a certificate against the contract source: recompute everything and
// compare the recorded rounding path step by step.
export function verifyCertificate(source, cert) {
  const program = compileSource(source);
  if (hashSource(source) !== cert.contract?.sha256) {
    throw conserveError(`certificate contract hash mismatch for order ${cert.order?.id}`);
  }
  const vm = new VM(program);
  const rawOrder = {
    id: cert.order.id,
    type: cert.order.type,
    amount: cert.order.amount,
    ...(cert.order.shares !== undefined ? { shares: cert.order.shares } : {}),
    ...(cert.order.overrides && Object.keys(cert.order.overrides).length
      ? { overrides: cert.order.overrides } : {}),
  };
  const order = normalizeOrder(rawOrder, program);
  const result = vm.execute(order);
  const rebuilt = buildCertificate(program, source, order, result);

  const fields = ['matchedTiers', 'candidates', 'ties', 'exactFee', 'totalFee', 'residual', 'residualAccount', 'steps'];
  for (const f of fields) {
    if (canonical(rebuilt[f]) !== canonical(cert[f])) {
      throw conserveError(`certificate replay mismatch on field '${f}' for order ${cert.order.id}`);
    }
  }
  return true;
}
