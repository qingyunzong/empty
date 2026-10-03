export class ValidationError extends Error {
  constructor(errors) {
    super(errors.join('; '));
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

const isInt = Number.isInteger;

export function validate(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError(['input must be a JSON object']);
  }

  const universe = input.skills;
  if (!Array.isArray(universe) || universe.length === 0 || !universe.every((s) => typeof s === 'string' && s)) {
    errors.push('skills: must be a non-empty array of declared skill names');
  }
  const skillSet = new Set(Array.isArray(universe) ? universe : []);

  const checkSkills = (list, where) => {
    if (!Array.isArray(list)) {
      errors.push(`${where}: missing skills array`);
      return;
    }
    for (const s of list) {
      if (typeof s !== 'string' || !skillSet.has(s)) {
        errors.push(`${where}: missing skill ${JSON.stringify(s)} (not declared in top-level skills)`);
      }
    }
  };

  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    errors.push('tasks: must be a non-empty array');
  } else {
    const ids = new Set();
    input.tasks.forEach((t, idx) => {
      const where = `tasks[${idx}]${t && typeof t.id === 'string' ? `(${t.id})` : ''}`;
      if (!t || typeof t !== 'object' || Array.isArray(t)) {
        errors.push(`${where}: must be an object`);
        return;
      }
      if (typeof t.id !== 'string' || !t.id) errors.push(`${where}: id must be a non-empty string`);
      else if (ids.has(t.id)) errors.push(`${where}: duplicate task id ${JSON.stringify(t.id)}`);
      else ids.add(t.id);
      if (typeof t.zone !== 'string' || !t.zone) errors.push(`${where}: zone must be a non-empty string`);
      checkSkills(t.skills, where);
      if (!isInt(t.duration) || t.duration <= 0) {
        errors.push(`${where}: duration must be a positive integer`);
      }
      if (!Array.isArray(t.window) || t.window.length !== 2 || !t.window.every(isInt)) {
        errors.push(`${where}: window must be [earliest, latest] integers`);
      } else {
        const [es, ls] = t.window;
        if (es < 0 || ls < es) {
          errors.push(`${where}: illegal window [${es}, ${ls}] (need 0 <= earliest <= latest)`);
        }
      }
    });
  }

  if (!Array.isArray(input.inspectors) || input.inspectors.length === 0) {
    errors.push('inspectors: must be a non-empty array');
  } else {
    const ids = new Set();
    input.inspectors.forEach((p, idx) => {
      const where = `inspectors[${idx}]${p && typeof p.id === 'string' ? `(${p.id})` : ''}`;
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        errors.push(`${where}: must be an object`);
        return;
      }
      if (typeof p.id !== 'string' || !p.id) errors.push(`${where}: id must be a non-empty string`);
      else if (ids.has(p.id)) errors.push(`${where}: duplicate inspector id ${JSON.stringify(p.id)}`);
      else ids.add(p.id);
      checkSkills(p.skills, where);
    });
  }

  if (input.travel !== undefined) {
    if (!input.travel || typeof input.travel !== 'object' || Array.isArray(input.travel)) {
      errors.push('travel: must be an object of zone -> zone -> non-negative integer');
    } else {
      for (const [a, row] of Object.entries(input.travel)) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          errors.push(`travel.${a}: must be an object of zone -> non-negative integer`);
          continue;
        }
        for (const [b, v] of Object.entries(row)) {
          if (!isInt(v)) errors.push(`travel.${a}.${b}: must be an integer`);
          else if (v < 0) errors.push(`travel.${a}.${b}: negative travel time ${v}`);
        }
      }
    }
  }

  if (errors.length) throw new ValidationError(errors);
}
