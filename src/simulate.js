'use strict';

const { Engine } = require('./engine');
const { Participant } = require('./participant');
const { Coordinator } = require('./coordinator');
const { verifyChain } = require('./certificate');

class ScenarioError extends Error {}

const CRASH_POINTS = new Set([
  'after-prepare-log',
  'after-commit-log',
  'after-apply-before-ack',
  'after-decision-log',
]);
const FAULT_ACTIONS = /^(drop|dup|corrupt|delay:\d+|dup:\d+)$/;
const PHASES = ['prepare', 'vote', 'commit', 'abort', 'ack'];

function validateScenario(s) {
  const fail = (m) => {
    throw new ScenarioError(m);
  };
  if (typeof s !== 'object' || s === null || Array.isArray(s)) fail('scenario must be an object');
  if (typeof s.accounts !== 'object' || s.accounts === null || Array.isArray(s.accounts) || Object.keys(s.accounts).length === 0) {
    fail('accounts must be a non-empty object');
  }
  for (const [name, a] of Object.entries(s.accounts)) {
    if (typeof a !== 'object' || a === null) fail(`account ${name}: must be an object`);
    if (!Number.isFinite(a.balance)) fail(`account ${name}: balance must be a finite number`);
    if (!Number.isFinite(a.creditLimit) || a.creditLimit < 0) fail(`account ${name}: creditLimit must be a non-negative number`);
  }
  const txs = s.txs === undefined ? [] : s.txs;
  if (!Array.isArray(txs)) fail('txs must be an array');
  const seen = new Set();
  for (const tx of txs) {
    if (typeof tx !== 'object' || tx === null) fail('tx must be an object');
    if (typeof tx.tx !== 'string' || tx.tx.length === 0) fail('tx.tx must be a non-empty string');
    if (seen.has(tx.tx)) fail(`duplicate tx id ${tx.tx}`);
    seen.add(tx.tx);
    if (!Array.isArray(tx.legs) || tx.legs.length === 0) fail(`tx ${tx.tx}: legs must be a non-empty array`);
    let sum = 0;
    const legAccts = new Set();
    for (const leg of tx.legs) {
      if (typeof leg !== 'object' || leg === null) fail(`tx ${tx.tx}: leg must be an object`);
      if (typeof leg.acct !== 'string' || !(leg.acct in s.accounts)) fail(`tx ${tx.tx}: unknown account ${leg.acct}`);
      if (legAccts.has(leg.acct)) fail(`tx ${tx.tx}: duplicate account ${leg.acct} in legs`);
      legAccts.add(leg.acct);
      if (!Number.isFinite(leg.amount) || leg.amount === 0) fail(`tx ${tx.tx}: leg amount must be a non-zero number`);
      sum += leg.amount;
    }
    if (sum !== 0) fail(`tx ${tx.tx}: legs must sum to zero`);
    if (tx.at !== undefined && (!Number.isFinite(tx.at) || tx.at < 0)) fail(`tx ${tx.tx}: bad at`);
  }
  if (s.participants !== undefined) {
    if (typeof s.participants !== 'object' || s.participants === null || Array.isArray(s.participants)) {
      fail('participants must be an object mapping participant id to account arrays');
    }
    const covered = new Set();
    for (const [pid, accts] of Object.entries(s.participants)) {
      if (!Array.isArray(accts) || accts.length === 0) fail(`participant ${pid}: must map to a non-empty array`);
      for (const a of accts) {
        if (!(a in s.accounts)) fail(`participant ${pid}: unknown account ${a}`);
        if (covered.has(a)) fail(`account ${a} assigned to multiple participants`);
        covered.add(a);
      }
    }
    for (const tx of txs) {
      for (const leg of tx.legs) {
        if (!covered.has(leg.acct)) fail(`account ${leg.acct} not assigned to any participant`);
      }
    }
  }
  const net = s.network || {};
  if (typeof net !== 'object' || net === null) fail('network must be an object');
  if (net.fragmentSize !== undefined && (!Number.isInteger(net.fragmentSize) || net.fragmentSize < 0)) {
    fail('network.fragmentSize must be a non-negative integer');
  }
  if (net.seed !== undefined && !Number.isInteger(net.seed)) fail('network.seed must be an integer');
  if (net.faults !== undefined) {
    if (!Array.isArray(net.faults)) fail('network.faults must be an array');
    for (const f of net.faults) {
      if (typeof f !== 'object' || f === null) fail('network fault must be an object');
      if (typeof f.action !== 'string' || !FAULT_ACTIONS.test(f.action)) fail(`bad fault action ${f.action}`);
      if (f.msgIndex !== undefined && (!Number.isInteger(f.msgIndex) || f.msgIndex < 0)) fail('fault msgIndex must be a non-negative integer');
      if (f.phase !== undefined && !PHASES.includes(f.phase)) fail(`fault phase invalid: ${f.phase}`);
      if (f.times !== undefined && (!Number.isInteger(f.times) || f.times < 1)) fail('fault times must be an integer >= 1');
    }
  }
  if (s.faults !== undefined) {
    if (!Array.isArray(s.faults)) fail('faults must be an array');
    for (const f of s.faults) {
      if (typeof f !== 'object' || f === null) fail('fault must be an object');
      if (typeof f.node !== 'string' || f.node.length === 0) fail('fault.node is required');
      if (!CRASH_POINTS.has(f.point)) fail(`fault.point must be one of ${[...CRASH_POINTS].join(', ')}`);
      if (f.tx !== undefined && typeof f.tx !== 'string') fail('fault.tx must be a string');
      if (f.restartDelay !== undefined && (!Number.isFinite(f.restartDelay) || f.restartDelay < 0)) fail('fault.restartDelay must be >= 0');
    }
  }
  if (s.ops !== undefined) {
    if (!Array.isArray(s.ops)) fail('ops must be an array');
    for (const op of s.ops) {
      if (typeof op !== 'object' || op === null) fail('op must be an object');
      if (op.op === 'status') {
        if (typeof op.tx !== 'string') fail('status op requires a tx string');
      } else if (op.op !== 'pending') {
        fail(`unknown op ${op.op}`);
      }
    }
  }
  for (const k of ['prepareTimeout', 'retryInterval', 'maxTime']) {
    if (s[k] !== undefined && (!Number.isFinite(s[k]) || s[k] <= 0)) fail(`${k} must be a positive number`);
  }
}

function runScenario(scenario) {
  validateScenario(scenario);
  const net = scenario.network || {};
  const engine = new Engine({
    faults: net.faults || [],
    fragmentSize: net.fragmentSize || 0,
    reorder: !!net.reorder,
    seed: net.seed ?? 1,
    crashes: scenario.faults || [],
    maxTime: scenario.maxTime ?? 5000,
  });
  engine.coordId = 'COORD';

  const accounts = scenario.accounts;
  const groups =
    scenario.participants ||
    Object.fromEntries(Object.keys(accounts).map((a) => [`P@${a}`, [a]]));
  const routing = {};
  for (const [pid, accts] of Object.entries(groups)) {
    const disk = { genesis: {}, wal: [] };
    for (const acct of accts) {
      disk.genesis[acct] = accounts[acct];
      routing[acct] = pid;
    }
    engine.register(pid, disk, (d) => new Participant(pid, d, engine));
  }
  const coordDisk = { wal: [], certChain: [] };
  engine.register(
    'COORD',
    coordDisk,
    (d) =>
      new Coordinator('COORD', d, engine, {
        prepareTimeout: scenario.prepareTimeout ?? 50,
        retryInterval: scenario.retryInterval ?? 10,
        routing,
      })
  );

  const txDefs = scenario.txs || [];
  for (const tx of txDefs) {
    engine.schedule(tx.at ?? 0, () => {
      const coord = engine.nodes.get('COORD');
      if (coord && !coord.crashed) coord.begin(tx);
    });
  }

  engine.run();

  const coord = engine.nodes.get('COORD');
  const results = {};
  for (const txDef of txDefs) {
    const tx = coord.txs.get(txDef.tx);
    if (tx && tx.decision) {
      results[txDef.tx] = {
        decision: tx.decision,
        reason: tx.reason || null,
        acks: Object.fromEntries(txDef.legs.map((l) => [l.acct, tx.acks.has(l.acct)])),
      };
    } else {
      results[txDef.tx] = { decision: 'pending', reason: tx ? tx.reason || null : 'not started', acks: {} };
    }
  }

  const balances = {};
  const pending = [];
  for (const [pid] of Object.entries(groups)) {
    const live = engine.nodes.get(pid);
    const node =
      live && !live.crashed ? live : new Participant(pid, engine.disks.get(pid), engine, { readOnly: true });
    for (const [acct, a] of node.accounts) {
      balances[acct] = { participant: pid, balance: a.balance, frozen: a.frozen, creditLimit: a.creditLimit };
    }
    pending.push(...node.pending());
  }

  const opsOut = [];
  let unknownTx = engine.errors.some((e) => e.type === 'UNKNOWN_TX');
  for (const op of scenario.ops || []) {
    if (op.op === 'status') {
      const tx = coord.txs.get(op.tx);
      if (!tx) {
        unknownTx = true;
        opsOut.push({ op: 'status', tx: op.tx, error: 'UNKNOWN_TX' });
      } else {
        opsOut.push({
          op: 'status',
          tx: op.tx,
          decision: tx.decision || 'pending',
          reason: tx.reason || null,
          votes: Object.fromEntries(tx.votes),
          acked: [...tx.acks],
        });
      }
    } else if (op.op === 'pending') {
      opsOut.push({ op: 'pending', pending });
    }
  }

  const certificate = { valid: verifyChain(coordDisk.certChain), chain: coordDisk.certChain };
  const output = { results, balances, pending, certificate, ops: opsOut, stats: engine.stats, errors: engine.errors };

  let exitCode = 0;
  if (engine.errors.some((e) => e.type === 'PROTOCOL')) exitCode = 2;
  else if (unknownTx) exitCode = 4;
  else if (Object.values(results).some((r) => r.decision === 'abort' && r.reason === 'INSUFFICIENT_FUNDS')) exitCode = 3;

  return { output, exitCode, engine };
}

module.exports = { runScenario, validateScenario, ScenarioError };
