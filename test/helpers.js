'use strict';

const { parsePolicy } = require('../src/policy');

function fixturePolicy() {
  return parsePolicy(
    JSON.stringify({
      version: 1,
      classifications: { public: 0, internal: 1, confidential: 2, secret: 3 },
      labels: {
        recipe: { upgradeTo: 'secret' },
        pii: { upgradeTo: 'confidential' },
        regulatory: { regulatory: true },
      },
      fields: {
        downtime_minutes: { classification: 'public' },
        machine_id: { classification: 'public' },
        root_cause: { classification: 'internal' },
        recipe_ratio: { classification: 'internal', labels: ['recipe'] },
        operator_name: { classification: 'internal', labels: ['pii'] },
        safety_code: { classification: 'public', labels: ['regulatory'] },
      },
      orgs: {
        factory: {
          clearance: 'confidential',
          allow: ['downtime_minutes', 'machine_id', 'root_cause', 'operator_name', 'safety_code'],
        },
        external: { clearance: 'internal', allow: ['downtime_minutes', 'machine_id'] },
        headquarters: {
          clearance: 'secret',
          allow: ['downtime_minutes', 'machine_id', 'root_cause', 'recipe_ratio', 'safety_code'],
        },
      },
      roles: {
        operator: { org: 'factory', allow: [], deny: [] },
        supplier: { org: 'external', allow: ['root_cause'], deny: [] },
        hq: { org: 'headquarters', allow: [], deny: [] },
      },
      individuals: {
        'op-7': { role: 'operator', allow: ['recipe_ratio'] },
        'op-8': { role: 'operator', deny: ['operator_name'] },
        'op-9': { role: 'operator', clearance: 'secret', allow: ['recipe_ratio'] },
      },
      views: {
        principals: ['operator', 'supplier', 'hq'],
        shared: { members: ['supplier', 'hq'] },
        leakChecks: [{ principal: 'supplier', label: 'recipe' }],
      },
    })
  );
}

function fixtureReport() {
  return {
    id: 'rpt-001',
    fields: {
      downtime_minutes: 42,
      machine_id: 'MX-12',
      root_cause: 'bearing wear',
      recipe_ratio: '3:2:1',
      operator_name: 'Zhang Wei',
      safety_code: 'GB-4706',
    },
  };
}

module.exports = { fixturePolicy, fixtureReport };
