import { Expr } from './ast.js';

export function print(e: Expr): string {
  switch (e.kind) {
    case 'const': return String(e.value);
    case 'var': return e.name;
    case 'bin': return `(${print(e.left)} ${e.op} ${print(e.right)})`;
    case 'log': return `log(${print(e.expr)})`;
    case 'if': return `if (${print(e.cond)}, ${print(e.then)}, ${print(e.else)})`;
    case 'let': return `let ${e.name} = ${print(e.value)} in ${print(e.body)}`;
  }
}
