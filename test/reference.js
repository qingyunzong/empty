'use strict';

// Independent message-level 2PC reference model, used to cross-check the
// full engine. It models the same protocol timing abstractly:
//   - link latency L per frame, prepare retransmit every R, timeout at T
//   - decision retransmit every R until acked
//   - faults: drop / duplicate / delay with occurrence int | "all"
// Scope: a single transaction, no crashes, no fragmentation. Written
// independently from src/ on purpose (no shared code).
function referenceOutcome(scenario) {
  const R = scenario.retransmitInterval ?? 10;
  const T = scenario.prepareTimeout ?? 50;
  const L = scenario.latency ?? 1;
  const maxTime = scenario.maxTime ?? 2000;
  const tx = scenario.txs[0];
  const legs = [
    { acct: tx.from, amount: -tx.amount },
    { acct: tx.to, amount: tx.amount },
  ];
  const acct0 = Object.fromEntries(scenario.accounts.map((a) => [a.id, a]));
  const faults = scenario.faults || [];

  function rulesFor(phase, acct, from, to) {
    const rules = [];
    for (const rule of faults) {
      const m = rule.match || {};
      if (m.tx !== undefined && m.tx !== tx.id) continue;
      if (m.phase !== undefined && m.phase !== phase) continue;
      if (m.acct !== undefined && m.acct !== acct) continue;
      if (m.from !== undefined && m.from !== from) continue;
      if (m.to !== undefined && m.to !== to) continue;
      if (rule.type === 'fragment') throw new Error('reference does not model fragment');
      rules.push(rule);
    }
    return rules;
  }

  // sendTimes[k] = send time of occurrence k. Returns sorted arrival times
  // (<= maxTime) after applying drop / duplicate / delay per occurrence.
  function arrivals(sendTimes, rules) {
    const out = [];
    sendTimes.forEach((s, k) => {
      let drop = false;
      let delay = 0;
      let copies = 1;
      for (const r of rules) {
        const applies = r.occurrence === 'all' || (r.occurrence ?? 0) === k;
        if (!applies) continue;
        if (r.type === 'drop') drop = true;
        else if (r.type === 'delay') delay += r.delay;
        else if (r.type === 'duplicate') copies += r.times ?? 1;
      }
      if (drop) return;
      for (let c = 0; c < copies; c++) {
        const t = s + L + delay;
        if (t <= maxTime) out.push(t);
      }
    });
    return out.sort((a, b) => a - b);
  }

  const sendsUpTo = (start, step, end) => {
    const out = [];
    for (let t = start; t <= end; t += step) out.push(t);
    return out;
  };
  const first = (arr) => (arr.length ? arr[0] : Infinity);

  // Votes are determined by the initial account state (single tx in flight).
  const votes = {};
  const reasons = {};
  for (const leg of legs) {
    const a = acct0[leg.acct];
    if (leg.amount < 0 && a.balance + leg.amount < 0) {
      votes[leg.acct] = 'no';
      reasons[leg.acct] = 'INSUFFICIENT_FUNDS';
    } else if (leg.amount > 0 && a.creditLimit != null && a.balance + leg.amount > a.creditLimit) {
      votes[leg.acct] = 'no';
      reasons[leg.acct] = 'CREDIT_LIMIT';
    } else {
      votes[leg.acct] = 'yes';
    }
  }

  // Pass 1: prepares may be sent until the prepare timeout at the latest.
  const prepArr = {};
  const voteArr = {};
  const computeFlows = (prepEnd) => {
    for (const leg of legs) {
      const pa = arrivals(sendsUpTo(0, R, prepEnd), rulesFor('prepare', leg.acct, 'c', 'p:' + leg.acct));
      prepArr[leg.acct] = pa;
      // Each prepare arrival triggers a (cached) vote reply.
      voteArr[leg.acct] = arrivals(pa, rulesFor('prepare', leg.acct, 'p:' + leg.acct, 'c'));
    }
  };
  computeFlows(T);

  // Coordinator decision.
  let decision;
  let reason = null;
  let D;
  const noLegs = legs.filter((l) => votes[l.acct] === 'no');
  if (noLegs.length) {
    decision = 'abort';
    const firstNo = Math.min(...noLegs.map((l) => first(voteArr[l.acct])));
    D = Math.min(firstNo, T);
    reason = firstNo <= T ? reasons[noLegs.find((l) => first(voteArr[l.acct]) === firstNo).acct] : 'PREPARE_TIMEOUT';
  } else {
    const maxYes = Math.max(...legs.map((l) => first(voteArr[l.acct])));
    if (maxYes <= T) {
      decision = 'commit';
      D = maxYes;
    } else {
      decision = 'abort';
      reason = 'PREPARE_TIMEOUT';
      D = T;
    }
  }

  // Pass 2: the coordinator stops retransmitting prepares once decided.
  computeFlows(D);

  // Decision propagation and per-participant final state.
  const accounts = {};
  const pending = [];
  let done = true;
  for (const leg of legs) {
    const decArr = arrivals(sendsUpTo(D, R, maxTime), rulesFor(decision, leg.acct, 'c', 'p:' + leg.acct));
    const events = [
      ...prepArr[leg.acct].map((t) => ({ t, k: 'p' })),
      ...decArr.map((t) => ({ t, k: 'd' })),
    ].sort((a, b) => a.t - b.t);
    let state = 'none';
    const acceptedAckSends = [];
    for (const e of events) {
      if (e.k === 'p') {
        if (state === 'none') state = votes[leg.acct] === 'yes' ? 'prepared' : 'aborted';
      } else {
        // Aborts are always accepted; commits are refused until prepared.
        if (decision === 'abort' || state !== 'none') acceptedAckSends.push(e.t);
        if (state === 'prepared') state = decision === 'commit' ? 'committed' : 'aborted';
      }
    }
    const ackArr = arrivals(acceptedAckSends, rulesFor(decision, leg.acct, 'p:' + leg.acct, 'c'));
    if (!ackArr.length) done = false;
    const a = acct0[leg.acct];
    let balance = a.balance;
    let frozen = 0;
    let incoming = 0;
    if (state === 'committed') {
      balance += leg.amount;
    } else if (state === 'prepared') {
      if (leg.amount < 0) frozen = -leg.amount;
      else incoming = leg.amount;
      pending.push({ node: 'p:' + leg.acct, tx: tx.id, acct: leg.acct, amount: leg.amount, state: 'prepared' });
    }
    accounts[leg.acct] = { balance, frozen, incoming, available: balance - frozen };
  }
  // Accounts not touched by the tx keep their initial state.
  for (const a of scenario.accounts) {
    if (!accounts[a.id]) {
      accounts[a.id] = { balance: a.balance, frozen: 0, incoming: 0, available: a.balance };
    }
  }
  return { decision, reason, done, accounts, pending };
}

module.exports = { referenceOutcome };
