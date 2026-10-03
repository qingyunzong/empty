'use strict';

const { CheckError, CLAIM, evalExpr, lookupAlias } = require('./term');
const { Ledger, scopeHash } = require('./ledger');

function newScope(parent) {
  return { parent: parent || null, aliases: new Map() };
}

// Walk the parsed program, maintaining lexical scopes, and record commits.
function buildLedger(program, key) {
  const ledger = new Ledger(key);

  function process(statements, scope) {
    for (const st of statements) {
      switch (st.kind) {
        case 'declare':
          if (lookupAlias(st.name, scope)) {
            throw new CheckError(`"${st.name}" conflicts with an alias in scope`);
          }
          ledger.commit(
            st.name,
            st.declType,
            st.name,
            st.declType === 'evidence' ? new Set([st.name]) : new Set(),
            scopeHash(scope),
          );
          break;
        case 'claim': {
          if (lookupAlias(st.name, scope)) {
            throw new CheckError(`"${st.name}" conflicts with an alias in scope`);
          }
          const value = evalExpr(st.expr, scope, ledger.symbols);
          if (value.type !== CLAIM) {
            throw new CheckError(
              `claim "${st.name}" must be a claim expression, got ${value.type}`,
            );
          }
          ledger.commit(st.name, CLAIM, value.canon, value.deps, scopeHash(scope));
          break;
        }
        case 'alias': {
          if (ledger.symbols.has(st.name)) {
            throw new CheckError(`alias "${st.name}" conflicts with a declared symbol`);
          }
          if (lookupAlias(st.name, scope)) {
            throw new CheckError(`duplicate alias "${st.name}"`);
          }
          const value = evalExpr(st.expr, scope, ledger.symbols);
          scope.aliases.set(st.name, { value });
          break;
        }
        case 'block':
          process(st.body, newScope(scope));
          break;
        case 'revoke':
          ledger.revoke(st.name);
          break;
        case 'undo':
          ledger.undo();
          break;
        case 'redo':
          ledger.redo();
          break;
        default:
          throw new CheckError(`unknown statement kind "${st.kind}"`);
      }
    }
  }

  process(program, newScope(null));
  return ledger;
}

module.exports = { buildLedger };
