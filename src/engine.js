// Tax-platform red-flush (红冲) verification engine.
//
// Semantics of check{invoiceId}: the feasible region of the invoice's
// constraints is intersected with the constraints of every active credit note
// referencing the invoice. A complete red-flush supplies, for each original
// constraint a*x <= b, the exact dual a*x >= b (zero tolerance), so the union
// collapses onto the original boundary and stays SAT. Any shortfall (e.g. one
// cent less) breaks feasibility and yields UNSAT plus an IIS certificate.

import { Rat } from './rational.js';
import {
  normalizeConstraint,
  rowsForCertificateEntry,
  isFeasible,
  findIIS,
  verifyIIS,
  enumerateVertices,
  boundFor,
  boxRows,
} from './lp.js';

export const MAX_DIM = 3;

export class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function pointToObject(vars, x) {
  const obj = {};
  vars.forEach((v, i) => {
    obj[v] = x[i].toString();
  });
  return obj;
}

function uniqueRefs(rows) {
  const seen = new Map();
  for (const row of rows) {
    if (!seen.has(row.ref.id)) seen.set(row.ref.id, row.ref);
  }
  return [...seen.values()];
}

function ratEq(x, y) {
  const rx = Rat.from(x);
  const ry = Rat.from(y);
  return rx.num === ry.num && rx.den === ry.den;
}

function rhsOf(ref) {
  return new Rat(BigInt(ref.rhsNum ?? 0), BigInt(ref.rhsDen ?? 1));
}

// Exact dual match with zero tolerance: same coefficients, same rhs, flipped op.
function isDual(a, b) {
  const dualOps = { '<=': '>=', '>=': '<=', '==': '==' };
  if (dualOps[a.op] !== b.op) return false;
  if (!Array.isArray(a.coefs) || !Array.isArray(b.coefs) || a.coefs.length !== b.coefs.length) return false;
  for (let i = 0; i < a.coefs.length; i++) {
    if (!ratEq(a.coefs[i], b.coefs[i])) return false;
  }
  const ra = rhsOf(a);
  const rb = rhsOf(b);
  return ra.num === rb.num && ra.den === rb.den;
}

function cancellationReport(invoiceRows, creditRows) {
  const invoiceConstraints = uniqueRefs(invoiceRows);
  const creditConstraints = uniqueRefs(creditRows);
  const uncanceled = [];
  for (const ic of invoiceConstraints) {
    if (!creditConstraints.some((cc) => isDual(ic, cc))) uncanceled.push(ic.id);
  }
  return {
    total: invoiceConstraints.length,
    canceled: invoiceConstraints.length - uncanceled.length,
    uncanceled,
  };
}

function makeRef(source, sourceId, index, c) {
  return {
    id: `${sourceId}#c${index}`,
    source,
    sourceId,
    index,
    coefs: c.coefs,
    op: c.op,
    rhsNum: c.rhsNum ?? 0,
    rhsDen: c.rhsDen ?? 1,
  };
}

function normalizeAll(constraints, source, sourceId, dim) {
  const rows = [];
  constraints.forEach((c, i) => {
    rows.push(...normalizeConstraint(c, makeRef(source, sourceId, i, c), dim));
  });
  return rows;
}

export class Engine {
  constructor() {
    this.invoices = new Map();
    this.credits = new Map();
    this.pinned = new Set();
    this.checks = [];
    this.creditSeq = 0;
  }

  invoice({ id, vars, constraints = [] }) {
    if (!id) throw new ApiError('E_INPUT', 'invoice requires an id');
    if (this.invoices.has(id)) throw new ApiError('E_INPUT', `duplicate invoice ${id}`);
    if (!Array.isArray(vars) || vars.length < 1 || vars.length > MAX_DIM) {
      throw new ApiError('E_DIM', `invoice ${id}: dimension ${vars?.length} outside 1..${MAX_DIM}`);
    }
    const rows = normalizeAll(constraints, 'invoice', id, vars.length);
    this.invoices.set(id, { id, vars: vars.slice(), rows });
    return { status: 'OK', id, dim: vars.length, constraints: constraints.length };
  }

  credit({ id, refId, constraints = [] }) {
    const inv = this.invoices.get(refId);
    if (!inv) throw new ApiError('E_REF', `credit references unknown invoice ${refId}`);
    const cid = id ?? `C${++this.creditSeq}`;
    if (this.credits.has(cid)) throw new ApiError('E_INPUT', `duplicate credit ${cid}`);
    const rows = normalizeAll(constraints, 'credit', cid, inv.vars.length);
    this.credits.set(cid, { id: cid, refId, rows });
    return { status: 'OK', id: cid, refId, constraints: constraints.length };
  }

  voidCredit({ id }) {
    if (!this.credits.has(id)) throw new ApiError('E_REF', `unknown credit ${id}`);
    if (this.pinned.has(id)) {
      throw new ApiError('E_PINNED', `credit ${id} is referenced by an issued check certificate`);
    }
    this.credits.delete(id);
    return { status: 'VOIDED', id };
  }

  check({ invoiceId }) {
    const inv = this.invoices.get(invoiceId);
    if (!inv) throw new ApiError('E_REF', `unknown invoice ${invoiceId}`);
    const n = inv.vars.length;
    const credits = [...this.credits.values()].filter((c) => c.refId === invoiceId);
    const creditIds = credits.map((c) => c.id);
    // Credit rows come first so the IIS deletion filter preferentially keeps
    // the invoice constraints that failed to be canceled (the "violated" set).
    const rows = credits.flatMap((c) => c.rows);
    rows.push(...inv.rows);

    let result;
    if (isFeasible(rows, n)) {
      const vertices = enumerateVertices(rows, n);
      let witness = vertices[0];
      if (!witness) {
        // Feasible but vertex-free (unbounded with lineality): use a boxed vertex.
        const bound = boundFor(rows, n);
        witness = enumerateVertices(rows.concat(boxRows(n, bound)), n)[0];
      }
      result = {
        status: 'SAT',
        invoiceId,
        credits: creditIds,
        witness: pointToObject(inv.vars, witness),
        vertices: vertices.map((v) => pointToObject(inv.vars, v)),
        cancellation: cancellationReport(inv.rows, credits.flatMap((c) => c.rows)),
      };
    } else {
      const iis = findIIS(rows, n);
      result = {
        status: 'UNSAT',
        error: 'E_UNSAT',
        invoiceId,
        credits: creditIds,
        violated: [...new Set(iis.filter((r) => r.ref.source === 'invoice').map((r) => r.ref.id))],
        iis: iis.map((r) => `${r.ref.id}[${r.part}]`),
        certificate: {
          type: 'IIS',
          dim: n,
          constraints: iis.map((r) => ({ ...r.ref, part: r.part })),
        },
      };
    }
    for (const cid of creditIds) this.pinned.add(cid);
    this.checks.push({ invoiceId, creditIds, status: result.status });
    return result;
  }

  findConstraint(id) {
    for (const inv of this.invoices.values()) {
      for (const row of inv.rows) if (row.ref.id === id) return row.ref;
    }
    for (const credit of this.credits.values()) {
      for (const row of credit.rows) if (row.ref.id === id) return row.ref;
    }
    return null;
  }

  verifyCertificate(certificate) {
    for (const c of certificate.constraints) {
      if (!this.findConstraint(c.id)) {
        throw new ApiError('E_REF', `certificate references unknown constraint ${c.id}`);
      }
    }
    return verifyCertificate(certificate);
  }
}

// Standalone exact verification of an IIS certificate: the subsystem must be
// infeasible and every proper single-deletion must be feasible.
export function verifyCertificate(certificate) {
  const rows = [];
  for (const c of certificate.constraints) {
    rows.push(...rowsForCertificateEntry(c, certificate.dim));
  }
  return verifyIIS(rows, certificate.dim);
}
