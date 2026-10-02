'use strict';

// Shared op dispatcher used by the CLI and the tests.
function dispatch(eng, op) {
  switch (op.op) {
    case 'addPlate': return eng.addPlate(op.plate);
    case 'addWell': return eng.addWell(op.plate, op.well, op.absorbance);
    case 'removeWell': return eng.removeWell(op.plate, op.well);
    case 'setAbsorbance': return eng.setAbsorbance(op.plate, op.well, op.absorbance);
    case 'setControl': return eng.setControl(op.plate, op.kind, op.well ?? null);
    case 'addReplicate': return eng.addReplicate(op.group, op.wells || []);
    case 'removeReplicate': return eng.removeReplicate(op.group);
    case 'moveWell': return eng.moveWell(op.from, op.to, op.well);
    case 'undo': return eng.undo();
    case 'redo': return eng.redo();
    case 'snapshot': return { op: 'snapshot', state: eng.getSnapshot() };
    default: return { error: 'E_OP', message: `unknown op: ${op.op}` };
  }
}

module.exports = { dispatch };
