import { QuotaError } from './errors.js';

// 表达式字节码求值; ctx: { node, buckets, amount, note }
export function evalExpr(code, ctx) {
  const stack = [];
  for (const ins of code) {
    switch (ins[0]) {
      case 'const':
        stack.push(ins[1]);
        break;
      case 'regex':
        stack.push({ __regex: true, source: ins[1], flags: ins[2] });
        break;
      case 'load': {
        let hit = false;
        for (let n = ctx.node; n; n = n.parent) {
          if (n.vars.has(ins[1])) {
            stack.push(n.vars.get(ins[1]));
            hit = true;
            break;
          }
        }
        if (!hit) throw new QuotaError('E_VALID', `unknown variable '${ins[1]}' at runtime`);
        break;
      }
      case 'amount':
        stack.push(ctx.amount ?? 0);
        break;
      case 'note':
        stack.push(ctx.note ?? '');
        break;
      case 'builtin': {
        const b = ctx.buckets.get(ins[2]);
        if (!b) throw new QuotaError('E_VALID', `unknown bucket '${ins[2]}' at runtime`);
        stack.push(b[ins[1]]);
        break;
      }
      case 'un': {
        const a = stack.pop();
        stack.push(ins[1] === 'not' ? !a : -a);
        break;
      }
      case 'bin': {
        const b = stack.pop();
        const a = stack.pop();
        switch (ins[1]) {
          case '+': stack.push(a + b); break;
          case '-': stack.push(a - b); break;
          case '*': stack.push(a * b); break;
          case '/': stack.push(a / b); break;
          case '<': stack.push(a < b); break;
          case '<=': stack.push(a <= b); break;
          case '>': stack.push(a > b); break;
          case '>=': stack.push(a >= b); break;
          case '==': stack.push(a === b); break;
          case '!=': stack.push(a !== b); break;
          case 'and': stack.push(Boolean(a && b)); break;
          case 'or': stack.push(Boolean(a || b)); break;
          case 'matches': stack.push(new RegExp(b.source, b.flags).test(a)); break;
          default: throw new Error(`unknown binop '${ins[1]}'`);
        }
        break;
      }
      default:
        throw new Error(`unknown instruction '${ins[0]}'`);
    }
  }
  return stack[stack.length - 1];
}

function makeNode(path, parent, name = '') {
  return {
    name,
    path,
    parent,
    caps: new Map(),
    guards: [],
    vars: new Map(),
    children: new Map(),
    consumed: new Map(), // bucket -> 该作用域子树已占用 (frozen+used)
  };
}

// VM: 执行脚本字节码, 构建策略 (桶三额 + 审批作用域树)
export function buildPolicy(ops) {
  const buckets = new Map();
  const root = makeNode('', null);
  const scopesByPath = new Map([['', root]]);
  const policy = {
    customer: null,
    noteWhitelist: null,
    validity: null,
    buckets,
    root,
    scopesByPath,
  };
  const stack = [root];
  const top = () => stack[stack.length - 1];

  for (const ins of ops) {
    switch (ins.op) {
      case 'customer':
        policy.customer = ins.id;
        break;
      case 'note_whitelist':
        policy.noteWhitelist = new RegExp(ins.source, ins.flags);
        break;
      case 'validity':
        policy.validity = { from: ins.from, to: ins.to };
        break;
      case 'bucket':
        buckets.set(ins.name, {
          limit: ins.limit,
          available: ins.limit,
          frozen: 0,
          used: 0,
        });
        break;
      case 'push_scope': {
        const parent = top();
        const path = parent.path ? `${parent.path}.${ins.name}` : ins.name;
        const node = makeNode(path, parent, ins.name);
        parent.children.set(ins.name, node);
        scopesByPath.set(path, node);
        stack.push(node);
        break;
      }
      case 'pop_scope':
        stack.pop();
        break;
      case 'cap':
        top().caps.set(ins.bucket, ins.value);
        break;
      case 'decl_var':
      case 'set_var':
        top().vars.set(ins.name, evalExpr(ins.expr, { node: top(), buckets }));
        break;
      case 'guard':
        top().guards.push({ target: ins.target, clauses: ins.clauses });
        break;
      default:
        throw new Error(`unknown op '${ins.op}'`);
    }
  }
  return policy;
}
