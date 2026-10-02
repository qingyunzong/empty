'use strict';

// Input validation. Every returned error is a CLI exit-code-2 condition:
// missing skills, negative travel times, illegal windows, or malformed schema.
function validate(model) {
  const errors = [];
  const isInt = (v) => Number.isInteger(v);

  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    return ['input must be a JSON object'];
  }

  if (!Array.isArray(model.tasks) || model.tasks.length === 0) {
    errors.push('tasks must be a non-empty array');
  } else {
    const ids = new Set();
    model.tasks.forEach((t, i) => {
      const where = `tasks[${i}]`;
      if (!t || typeof t !== 'object' || Array.isArray(t)) {
        errors.push(`${where} must be an object`);
        return;
      }
      const label = t.id === undefined ? where : `task "${t.id}"`;
      if (typeof t.id !== 'string' || t.id === '') {
        errors.push(`${where}.id must be a non-empty string`);
      } else if (ids.has(t.id)) {
        errors.push(`${label}: duplicated task id`);
      } else {
        ids.add(t.id);
      }
      if (
        !Array.isArray(t.skills) ||
        t.skills.length === 0 ||
        !t.skills.every((s) => typeof s === 'string' && s !== '')
      ) {
        errors.push(`${label}: missing skills (non-empty array of strings required)`);
      }
      if (!isInt(t.duration) || t.duration <= 0) {
        errors.push(`${label}: duration must be a positive integer`);
      }
      if (
        !t.window ||
        typeof t.window !== 'object' ||
        !isInt(t.window.start) ||
        !isInt(t.window.end) ||
        t.window.start < 0 ||
        t.window.end < t.window.start
      ) {
        errors.push(
          `${label}: illegal window (need integer 0 <= start <= end, got ${JSON.stringify(t.window)})`
        );
      }
      if (typeof t.zone !== 'string' || t.zone === '') {
        errors.push(`${label}: zone must be a non-empty string`);
      }
    });
  }

  if (!Array.isArray(model.inspectors) || model.inspectors.length === 0) {
    errors.push('inspectors must be a non-empty array');
  } else {
    const ids = new Set();
    model.inspectors.forEach((p, i) => {
      const where = `inspectors[${i}]`;
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        errors.push(`${where} must be an object`);
        return;
      }
      const label = p.id === undefined ? where : `inspector "${p.id}"`;
      if (typeof p.id !== 'string' || p.id === '') {
        errors.push(`${where}.id must be a non-empty string`);
      } else if (ids.has(p.id)) {
        errors.push(`${label}: duplicated inspector id`);
      } else {
        ids.add(p.id);
      }
      if (!Array.isArray(p.skills) || !p.skills.every((s) => typeof s === 'string')) {
        errors.push(`${label}: missing skills (array of strings required)`);
      }
    });
  }

  if (model.travel !== undefined) {
    if (!model.travel || typeof model.travel !== 'object' || Array.isArray(model.travel)) {
      errors.push('travel must be an object mapping zone -> zone -> integer time');
    } else {
      for (const [a, row] of Object.entries(model.travel)) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          errors.push(`travel.${a} must be an object mapping zone -> integer time`);
          continue;
        }
        for (const [b, v] of Object.entries(row)) {
          if (!isInt(v)) {
            errors.push(`travel.${a}.${b} must be an integer`);
          } else if (v < 0) {
            errors.push(`travel.${a}.${b} must not be negative (got ${v})`);
          } else {
            const rev = model.travel[b] && model.travel[b][a];
            if (rev !== undefined && rev !== v) {
              errors.push(`travel.${a}.${b}=${v} conflicts with travel.${b}.${a}=${rev}`);
            }
          }
        }
      }
    }
  }

  return errors;
}

module.exports = { validate };
