'use strict';

const { AuditError } = require('./errors');
const { parseRegex } = require('./regex');

// Normalize a rules file into validated rule objects.
// Accepted shapes:
//   {"rules": ["pattern", {"id": "...", "pattern": "...", "action": "..."}]}
//   ["pattern", ...]
// Every pattern is compiled here, so invalid rules fail with BAD_REGEX
// before any state is written.
function loadRules(obj) {
  const list = Array.isArray(obj) ? obj : obj && Array.isArray(obj.rules) ? obj.rules : null;
  if (!list) {
    throw new AuditError('BAD_REGEX', 'rules file must contain a "rules" array');
  }
  return list.map((entry, i) => {
    let id;
    let pattern;
    let action;
    if (typeof entry === 'string') {
      id = `r${i + 1}`;
      pattern = entry;
      action = 'flag';
    } else if (entry && typeof entry === 'object') {
      id = entry.id === undefined ? `r${i + 1}` : String(entry.id);
      pattern = entry.pattern;
      action = entry.action === undefined ? 'flag' : String(entry.action);
    } else {
      throw new AuditError('BAD_REGEX', `rule ${i + 1} is not a string or object`);
    }
    const ast = parseRegex(pattern);
    return { id, pattern, action, ast };
  });
}

module.exports = { loadRules };
