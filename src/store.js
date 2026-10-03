'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { UsageError } = require('./model');
const { canon, sha256 } = require('./canon');

function paths(stateDir) {
  return {
    scenario: path.join(stateDir, 'scenario.json'),
    events: path.join(stateDir, 'events.log'),
    plan: path.join(stateDir, 'plan.json'),
    state: path.join(stateDir, 'state.json'),
  };
}

function loadScenario(stateDir) {
  const p = paths(stateDir).scenario;
  if (!fs.existsSync(p)) throw new UsageError(`no scenario in ${stateDir}; run ingest first`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readEvents(stateDir) {
  const p = paths(stateDir).events;
  if (!fs.existsSync(p)) return [];
  const text = fs.readFileSync(p, 'utf8').trim();
  if (!text) return [];
  return text.split('\n').map((line) => JSON.parse(line));
}

function appendEvent(stateDir, ev) {
  fs.appendFileSync(paths(stateDir).events, JSON.stringify(ev) + '\n');
}

// state.json / plan.json are pure caches: every command re-folds scenario +
// events.log, so deleting them (a crash) and re-running reproduces identical
// output.
function writeOutputs(stateDir, scenario, events, result) {
  const p = paths(stateDir);
  fs.writeFileSync(p.plan, JSON.stringify(result.plan, null, 2) + '\n');
  fs.writeFileSync(
    p.state,
    JSON.stringify(
      { scenarioHash: sha256(canon(scenario)), events: events.length, planId: result.plan.planId },
      null,
      2
    ) + '\n'
  );
}

module.exports = { paths, loadScenario, readEvents, appendEvent, writeOutputs };
