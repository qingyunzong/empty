'use strict';

const { InputError } = require('./errors');

function validateTasks(raw, label) {
  const fail = (msg) => { throw new InputError(`${label}: ${msg}`); };
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail('tasks must be an array');
  const seen = new Set();
  return raw.map((task, index) => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      fail(`task #${index} must be an object`);
    }
    if (typeof task.id !== 'string' || task.id === '') {
      fail(`task #${index} is missing a non-empty string id`);
    }
    if (seen.has(task.id)) fail(`duplicate task id: ${task.id}`);
    seen.add(task.id);
    if (!Number.isInteger(task.cost) || task.cost < 0) {
      fail(`task ${task.id}: cost must be a non-negative integer`);
    }
    if (!Array.isArray(task.covers) || !task.covers.every((c) => typeof c === 'string')) {
      fail(`task ${task.id}: covers must be an array of state names`);
    }
    return { id: task.id, cost: task.cost, covers: [...new Set(task.covers)] };
  });
}

function validateTaskCovers(tasks, oldStateSet) {
  for (const task of tasks) {
    for (const covered of task.covers) {
      if (!oldStateSet.has(covered)) {
        throw new InputError(`new: task ${task.id}: missing state in covers: ${covered}`);
      }
    }
  }
}

function validateMachine(raw, label) {
  const fail = (msg) => { throw new InputError(`${label}: ${msg}`); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('machine definition must be a JSON object');
  }
  const { states, alphabet, start, transitions, risk } = raw;
  if (!Array.isArray(states) || states.length === 0 || !states.every((s) => typeof s === 'string')) {
    fail('states must be a non-empty array of strings');
  }
  const stateSet = new Set(states);
  if (stateSet.size !== states.length) fail('states contain duplicates');
  if (!Array.isArray(alphabet) || alphabet.length === 0 || !alphabet.every((s) => typeof s === 'string')) {
    fail('alphabet must be a non-empty array of strings');
  }
  if (new Set(alphabet).size !== alphabet.length) fail('alphabet contains duplicates');
  if (typeof start !== 'string' || !stateSet.has(start)) {
    fail(`missing state: start ${JSON.stringify(start)} is not in states`);
  }
  if (!transitions || typeof transitions !== 'object' || Array.isArray(transitions)) {
    fail('transitions must be an object');
  }
  const tr = {};
  for (const state of states) {
    const row = transitions[state];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      fail(`missing transitions for state ${state}`);
    }
    tr[state] = {};
    for (const symbol of alphabet) {
      const target = row[symbol];
      if (typeof target !== 'string' || !stateSet.has(target)) {
        fail(`missing state: transition target for (${state}, ${symbol})`);
      }
      tr[state][symbol] = target;
    }
  }
  if (!risk || typeof risk !== 'object' || Array.isArray(risk)) {
    fail('risk must be an object mapping states to grades');
  }
  const rk = {};
  for (const state of states) {
    const value = risk[state];
    if (typeof value !== 'string' && typeof value !== 'number') {
      fail(`missing risk grade for state ${state}`);
    }
    rk[state] = String(value);
  }
  return {
    states: [...states],
    alphabet: [...alphabet],
    start,
    transitions: tr,
    risk: rk,
    tasks: validateTasks(raw.tasks, label),
  };
}

module.exports = { validateMachine, validateTaskCovers };
