'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Clock = require('./clock');
const Network = require('./network');
const Participant = require('./participant');
const Coordinator = require('./coordinator');
const frames = require('./frames');
const { validateScenario } = require('./scenario');
const { buildCertificates, chainHeads } = require('./certificate');

class Engine {
  constructor(scenario, opts = {}) {
    validateScenario(scenario);
    this.scenario = scenario;
    this.clock = new Clock();
    this.R = scenario.retransmitInterval ?? 10;
    this.T = scenario.prepareTimeout ?? 50;
    this.maxTime = scenario.maxTime ?? 2000;
    this.events = [];
    this.violations = [];
    this.walDir = scenario.walDir || fs.mkdtempSync(path.join(os.tmpdir(), '2pc-wal-'));
    fs.mkdirSync(this.walDir, { recursive: true });
    this.reassemblers = new Map();
    this.network = new Network(this.clock, {
      latency: scenario.latency ?? 1,
      faults: scenario.faults || [],
      onDeliver: (to, payload) => this._deliver(to, payload),
      onEvent: (e) => this.event(e),
    });
    this.crashes = (scenario.crashes || []).map((c) => ({ restartAfter: 5, tx: '*', ...c, fired: false }));
    this.ctx = {
      clock: this.clock,
      network: this.network,
      now: () => this.clock.now,
      R: this.R,
      T: this.T,
      walPath: (node) => path.join(this.walDir, node.replace(':', '_') + '.wal'),
      hook: (node, tx, when) => this._hook(node, tx, when),
      event: (e) => this.event(e),
      violation: (v) => this.violation(v),
    };
    this.coordinator = new Coordinator(this.ctx);
    this.participants = new Map();
    for (const acct of scenario.accounts) {
      this.participants.set(acct.id, new Participant(this.ctx, acct.id, acct));
    }
    for (const tx of scenario.txs || []) {
      this.clock.schedule(tx.at ?? 0, 1, () => this.coordinator.beginTx(tx));
    }
    (scenario.actions || []).forEach((a, i) => {
      this.clock.schedule(a.at ?? 0, 1, () => this._action(a, i));
    });
  }

  event(e) {
    this.events.push({ ts: this.clock.now, event: e });
  }

  violation(v) {
    this.violations.push({ ts: this.clock.now, violation: v });
    this.events.push({ ts: this.clock.now, event: `VIOLATION ${v}` });
  }

  _node(id) {
    if (id === 'c') return this.coordinator;
    if (id.startsWith('p:')) return this.participants.get(id.slice(2));
    return null;
  }

  _hook(node, tx, when) {
    const target = this._node(node);
    if (!target || target.crashed) return true;
    for (const c of this.crashes) {
      if (c.fired || c.node !== node || c.when !== when) continue;
      if (c.tx !== '*' && c.tx !== tx) continue;
      c.fired = true;
      target.crashed = true;
      this.event(`crash ${node} ${when} tx=${tx}`);
      this.clock.schedule(c.restartAfter, 1, () => {
        this.event(`restart ${node}`);
        target.recover();
      });
      return true;
    }
    return false;
  }

  _deliver(to, payload) {
    let frame;
    if (payload.frag) {
      const key = `${payload.from}>${to}`;
      let r = this.reassemblers.get(key);
      if (!r) {
        r = new frames.Reassembler();
        this.reassemblers.set(key, r);
      }
      try {
        frame = r.push(payload);
      } catch (e) {
        return this.violation(`reassembly: ${e.message}`);
      }
      if (!frame) return;
    } else {
      frame = payload.frame;
    }
    let msg;
    try {
      msg = frames.decodeMessage(frame);
    } catch (e) {
      return this.violation(`decode: ${e.message}`);
    }
    const node = this._node(to);
    if (!node) return this.violation(`unknown destination ${to}`);
    if (node.crashed) return; // node is down: the frame is lost
    node.receive(payload.from, msg);
  }

  _action(a, i) {
    if (a.op === 'send') {
      const msg = { tx: a.msg.tx, phase: a.msg.phase, acct: a.msg.acct, amount: a.msg.amount, seq: 1000 + i, ack: 0 };
      this.event(`inject ${a.msg.phase} ${a.from || 'c'}->${a.to} tx=${a.msg.tx}`);
      this.network.send(a.from || 'c', a.to, msg);
    }
  }

  run() {
    this.completed = this.clock.run(this.maxTime);
    return this._report();
  }

  _query(q) {
    if (q.op === 'txStatus') {
      const cst = this.coordinator.txs.get(q.tx);
      const states = [];
      for (const p of this.participants.values()) {
        const st = p.txs.get(q.tx);
        if (st) states.push({ node: p.id, state: st.state, vote: st.vote });
      }
      const found = !!cst || states.length > 0;
      return {
        op: q.op,
        tx: q.tx,
        found,
        ...(cst ? { decision: cst.decision, reason: cst.reason, done: cst.done } : {}),
        participants: states,
      };
    }
    return { op: q.op, error: 'unsupported query' };
  }

  _report() {
    const txs = [...this.coordinator.txs.values()].map((st) => ({
      id: st.id,
      decision: st.decision,
      reason: st.reason,
      done: st.done,
      votes: Object.fromEntries([...st.votes.entries()].map(([acct, v]) => [acct, v.vote])),
    }));
    const accounts = this.scenario.accounts.map((a) => {
      const p = this.participants.get(a.id);
      return { id: a.id, balance: p.balance, frozen: p.frozen, incoming: p.incoming, available: p.balance - p.frozen };
    });
    const participantStates = [...this.participants.values()].map((p) => ({
      node: p.id,
      acct: p.acct,
      txs: [...p.txs.entries()].map(([tx, st]) => ({ tx, vote: st.vote, state: st.state, amount: st.amount })),
    }));
    const pending = [];
    for (const ps of participantStates) {
      for (const t of ps.txs) {
        if (t.state === 'prepared') pending.push({ node: ps.node, tx: t.tx, acct: ps.acct, amount: t.amount, state: t.state });
      }
    }
    for (const st of this.coordinator.txs.values()) {
      if (!st.decision && !st.done) pending.push({ node: 'c', tx: st.id, state: 'preparing' });
    }
    const wals = [this.coordinator.wal, ...[...this.participants.values()].map((p) => p.wal)];
    const certificates = buildCertificates(wals, (this.scenario.txs || []).map((t) => t.id));
    const queryResults = (this.scenario.queries || []).map((q) => this._query(q));
    return {
      completed: this.completed,
      walDir: this.walDir,
      txs,
      accounts,
      pending,
      participantStates,
      certificates,
      hashChainHead: chainHeads(certificates.map((c) => c.head)),
      violations: this.violations,
      events: this.events,
      queryResults,
    };
  }
}

module.exports = { Engine };
