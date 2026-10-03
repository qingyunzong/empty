'use strict';

const crypto = require('crypto');

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

function certificate(engine) {
  const clusters = engine.getAllClusters();
  const difference = clusters.filter((c) => c.status !== 'SETTLED');
  const payload = {
    events: engine.events,
    rulesVersion: engine.rule.version,
    history: engine.history,
    clusters: clusters.map((c) => ({
      id: c.id,
      status: c.status,
      memberKeys: c.memberKeys,
      reasons: c.reasons,
    })),
    suggestions: engine.getSuggestions(),
  };
  return {
    type: 'certificate',
    sha256: crypto.createHash('sha256').update(canonical(payload)).digest('hex'),
    eventCount: engine.events.length,
    rulesVersion: engine.rule.version,
    clusterCount: clusters.length,
    differenceClusterCount: difference.length,
    settledClusterCount: clusters.length - difference.length,
    historyCount: engine.history.length,
  };
}

module.exports = { certificate, canonical };
