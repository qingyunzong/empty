'use strict';

const { Rat, parseRat } = require('./rational');
const { feasiblePoint, findIIS, farkasCertificate, verifyCertificate } = require('./lp');

const MAX_DIM = 3;

function err(code, extra) {
  return Object.assign({ status: 'ERROR', error: code }, extra || {});
}

function parseConstraint(raw, id, dim) {
  if (!raw || !Array.isArray(raw.coefs)) throw new Error(`constraint ${id}: missing coefs`);
  const coefs = raw.coefs.map(parseRat);
  if (coefs.length !== dim) {
    const e = new Error(`constraint ${id}: coefs length ${coefs.length} != dim ${dim}`);
    e.code = 'E_DIM';
    throw e;
  }
  if (!['<=', '>=', '=='].includes(raw.op)) throw new Error(`constraint ${id}: bad op ${raw.op}`);
  let rhs;
  if (raw.rhs !== undefined) {
    rhs = parseRat(raw.rhs);
  } else if (raw.rhsNum !== undefined) {
    rhs = new Rat(BigInt(raw.rhsNum), BigInt(raw.rhsDen === undefined ? 1 : raw.rhsDen));
  } else {
    throw new Error(`constraint ${id}: missing rhs`);
  }
  return { id, coefs, op: raw.op, rhs };
}

class Engine {
  constructor() {
    this.invoices = new Map(); // id -> { id, vars, dim, constraints }
    this.credits = new Map(); // creditId -> { id, refId, constraints }
    this.pinned = new Set(); // creditIds referenced by some check's certificate
    this.seq = 0;
  }

  exec(cmd) {
    try {
      switch (cmd && cmd.cmd) {
        case 'invoice': return this.addInvoice(cmd);
        case 'credit': return this.addCredit(cmd);
        case 'voidCredit': return this.voidCredit(cmd);
        case 'check': return this.check(cmd);
        default: return err('E_CMD', { message: `unknown command: ${cmd && cmd.cmd}` });
      }
    } catch (e) {
      if (e.code === 'E_DIM') return err('E_DIM', { message: e.message });
      return err('E_CMD', { message: e.message });
    }
  }

  addInvoice(cmd) {
    if (typeof cmd.id !== 'string' || !Array.isArray(cmd.vars)) {
      return err('E_CMD', { message: 'invoice requires id and vars' });
    }
    const dim = cmd.vars.length;
    const constraints = (cmd.constraints || []).map((c, i) =>
      parseConstraint(c, `${cmd.id}#c${i}`, dim));
    this.invoices.set(cmd.id, { id: cmd.id, vars: cmd.vars.slice(), dim, constraints });
    return { status: 'OK', id: cmd.id, dim };
  }

  addCredit(cmd) {
    const inv = this.invoices.get(cmd.refId);
    if (!inv) return err('E_REF', { message: `unknown invoice: ${cmd.refId}` });
    const creditId = typeof cmd.id === 'string' ? cmd.id : `credit-${++this.seq}`;
    const constraints = (cmd.constraints || []).map((c, i) =>
      parseConstraint(c, `${creditId}#c${i}`, inv.dim));
    this.credits.set(creditId, { id: creditId, refId: cmd.refId, constraints });
    return { status: 'OK', id: creditId, refId: cmd.refId };
  }

  voidCredit(cmd) {
    const credit = this.credits.get(cmd.id);
    if (!credit) return err('E_REF', { message: `unknown credit: ${cmd.id}` });
    if (this.pinned.has(cmd.id)) {
      return err('E_PINNED', { id: cmd.id, message: 'credit is referenced by a check certificate' });
    }
    this.credits.delete(cmd.id);
    return { status: 'OK', id: cmd.id, restored: credit.refId };
  }

  // Active constraint pool for an invoice: its own constraints plus the
  // (dual, negated) constraints of every live credit against it.
  gatherConstraints(invoiceId) {
    const inv = this.invoices.get(invoiceId);
    if (!inv) return null;
    const all = inv.constraints.map((c) => Object.assign({ owner: null }, c));
    for (const credit of this.credits.values()) {
      if (credit.refId !== invoiceId) continue;
      for (const c of credit.constraints) all.push(Object.assign({ owner: credit.id }, c));
    }
    return { inv, all };
  }

  check(cmd) {
    const got = this.gatherConstraints(cmd.invoiceId);
    if (!got) return err('E_REF', { message: `unknown invoice: ${cmd.invoiceId}` });
    const { inv, all } = got;
    if (inv.dim > MAX_DIM) {
      return { status: 'UNDECIDED', error: 'E_DIM', invoiceId: inv.id, dim: inv.dim };
    }
    const res = feasiblePoint(all, inv.dim);
    if (res.sat) {
      const vertex = {};
      inv.vars.forEach((v, i) => { vertex[v] = res.point[i].toString(); });
      return { status: 'SAT', invoiceId: inv.id, vertex };
    }
    const iisIdx = findIIS(all, inv.dim);
    const iis = iisIdx.map((i) => all[i]);
    const cert = farkasCertificate(iis, inv.dim);
    for (const c of iis) if (c.owner) this.pinned.add(c.owner);
    return {
      status: 'UNSAT',
      error: 'E_UNSAT',
      invoiceId: inv.id,
      violated: iis.map((c) => c.id),
      certificate: {
        multipliers: cert.map((e) => ({ id: e.id, sub: e.sub, lambda: e.lambda.toString() })),
      },
    };
  }

  // Re-verify a previously emitted UNSAT certificate against the current
  // active constraint pool of an invoice.
  verify(invoiceId, certificate) {
    const got = this.gatherConstraints(invoiceId);
    if (!got) return { ok: false, reason: 'E_REF' };
    const ok = verifyCertificate(got.all, got.inv.dim, certificate.multipliers || []);
    return { ok };
  }
}

module.exports = { Engine, MAX_DIM };
