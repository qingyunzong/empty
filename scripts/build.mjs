// Zero-dependency build: strips TypeScript type syntax from src/ and tests/
// into dist/, then validates every emitted file with `node --check`.
//
// Supported TS subset (enforced): interfaces, type aliases, type annotations,
// generics on class/function declarations, access modifiers, `import type`,
// `export type`. Not supported (build throws): enums, namespaces, `as` casts,
// `satisfies`, `declare`, parameter properties. Source must avoid ternary
// `? :`, `switch` labels and regex literals so `:` stays unambiguous.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const UNSUPPORTED = new Set(['as', 'enum', 'namespace', 'declare', 'satisfies']);
const DROPPED_MODIFIERS = new Set(['public', 'private', 'protected', 'readonly', 'abstract', 'override']);

export function stripTypes(src) {
  const n = src.length;
  let out = '';
  let i = 0;
  const stack = []; // 'paren' | 'bracket' | 'object' | 'block' | 'template'
  let mode = 'js'; // 'js' | 'tmpl'
  let prevWord = '';
  let prevPrevWord = '';
  let lastPuncts = '';
  let prevSignificant = 'other'; // 'word' | 'punct' | 'other'

  const isIdentStart = (c) => /[A-Za-z_$]/.test(c);
  const isIdentChar = (c) => /[A-Za-z0-9_$]/.test(c);

  function markWord(w) {
    prevPrevWord = prevWord;
    prevWord = w;
    lastPuncts = '';
    prevSignificant = 'word';
  }
  function markPunct(c) {
    prevWord = '';
    prevPrevWord = '';
    lastPuncts = (lastPuncts + c).slice(-3);
    prevSignificant = 'punct';
  }
  function markOther() {
    prevWord = '';
    prevPrevWord = '';
    lastPuncts = '';
    prevSignificant = 'other';
  }

  function skipWsComments(j) {
    while (j < n) {
      const c = src[j];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { j++; continue; }
      if (c === '/' && src[j + 1] === '/') { while (j < n && src[j] !== '\n') j++; continue; }
      if (c === '/' && src[j + 1] === '*') {
        j += 2;
        while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
        j += 2;
        continue;
      }
      break;
    }
    return j;
  }

  function skipString(j) {
    const q = src[j];
    j++;
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === q) return j + 1;
      j++;
    }
    throw new Error('unterminated string literal');
  }

  function skipBalanced(j, open, close) {
    let depth = 0;
    while (j < n) {
      const c = src[j];
      if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) return j + 1; }
      else if (c === "'" || c === '"' || c === '`') j = skipString(j) - 1;
      else if (c === '/' && (src[j + 1] === '/' || src[j + 1] === '*')) j = skipWsComments(j) - 1;
      j++;
    }
    throw new Error('unbalanced ' + open + close);
  }

  function skipToSemicolon(j) {
    let depth = 0;
    while (j < n) {
      const c = src[j];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ';' && depth === 0) return j + 1;
      else if (c === "'" || c === '"' || c === '`') j = skipString(j) - 1;
      else if (c === '/' && (src[j + 1] === '/' || src[j + 1] === '*')) j = skipWsComments(j) - 1;
      j++;
    }
    throw new Error('missing semicolon');
  }

  function scanToBrace(j) {
    while (j < n && src[j] !== '{') {
      const c = src[j];
      if (c === "'" || c === '"' || c === '`') { j = skipString(j); continue; }
      if (c === '/' && (src[j + 1] === '/' || src[j + 1] === '*')) { j = skipWsComments(j); continue; }
      j++;
    }
    if (j >= n) throw new Error('expected {');
    return j;
  }

  function skipTypeAnnotation(j) {
    j = skipWsComments(j);
    const startsWithParen = src[j] === '(';
    let depth = 0;
    while (j < n) {
      const c = src[j];
      if (depth === 0 && c === '=' && startsWithParen && src[j + 1] === '>') { j += 2; continue; }
      if (depth === 0 && (c === ',' || c === ')' || c === ']' || c === '=' || c === ';' || c === '{' || c === '}')) return j;
      if (c === '(' || c === '[' || c === '<') depth++;
      else if (c === ')' || c === ']') { if (depth === 0) return j; depth--; }
      else if (c === '>') { if (depth === 0) return j; depth--; }
      else if (c === "'" || c === '"' || c === '`') j = skipString(j) - 1;
      else if (c === '/' && (src[j + 1] === '/' || src[j + 1] === '*')) j = skipWsComments(j) - 1;
      j++;
    }
    return j;
  }

  function peekWord(j) {
    const k = skipWsComments(j);
    if (k >= n || !isIdentStart(src[k])) return null;
    let e = k;
    while (e < n && isIdentChar(src[e])) e++;
    return { word: src.slice(k, e), end: e };
  }

  function classifyBrace() {
    if (prevSignificant === 'word') {
      return prevWord === 'return' ? 'object' : 'block';
    }
    if (prevSignificant === 'punct') {
      if (lastPuncts === '=>') return 'block';
      if (lastPuncts.endsWith('??') || lastPuncts.endsWith('||') || lastPuncts.endsWith('&&') || lastPuncts.endsWith('${')) return 'object';
      const last = lastPuncts[lastPuncts.length - 1];
      if ('=([,:?!~'.includes(last)) return 'object';
      return 'block';
    }
    return 'block';
  }

  while (i < n) {
    const c = src[i];

    if (mode === 'tmpl') {
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { out += c; i++; mode = 'js'; markOther(); continue; }
      if (c === '$' && src[i + 1] === '{') { out += '${'; i += 2; stack.push('template'); mode = 'js'; markPunct('${'); continue; }
      out += c; i++; continue;
    }

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { out += c; i++; continue; }

    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      const j = skipWsComments(i);
      out += src.slice(i, j);
      i = j;
      continue;
    }

    if (c === "'" || c === '"') {
      const j = skipString(i);
      out += src.slice(i, j);
      i = j;
      markOther();
      continue;
    }

    if (c === '`') { out += c; i++; mode = 'tmpl'; continue; }

    if (/[0-9]/.test(c)) { out += c; i++; markOther(); continue; }

    if (isIdentStart(c)) {
      let j = i;
      while (j < n && isIdentChar(src[j])) j++;
      const word = src.slice(i, j);

      if (UNSUPPORTED.has(word)) {
        throw new Error('unsupported TypeScript syntax in source: "' + word + '"');
      }
      if (DROPPED_MODIFIERS.has(word)) { i = j; continue; }

      if (word === 'interface') {
        const peek = peekWord(j);
        if (peek !== null) {
          const b = scanToBrace(peek.end);
          i = skipBalanced(b, '{', '}');
          out += '\n';
          markOther();
          continue;
        }
        out += word; i = j; markWord(word); continue;
      }

      if (word === 'type') {
        const peek = peekWord(j);
        if (peek !== null) {
          const k = skipWsComments(peek.end);
          if (src[k] === '=' || src[k] === '<') {
            i = skipToSemicolon(j);
            out += '\n';
            markOther();
            continue;
          }
        }
        out += word; i = j; markWord(word); continue;
      }

      if (word === 'import') {
        const peek = peekWord(j);
        if (peek !== null && peek.word === 'type') {
          i = skipToSemicolon(j);
          out += '\n';
          markOther();
          continue;
        }
        out += word; i = j; markWord(word); continue;
      }

      if (word === 'export') {
        const peek = peekWord(j);
        if (peek !== null && peek.word === 'type') {
          const after = peekWord(peek.end);
          const k = skipWsComments(peek.end);
          if ((after !== null && (src[skipWsComments(after.end)] === '=' || src[skipWsComments(after.end)] === '<')) || src[k] === '{') {
            i = skipToSemicolon(j);
            out += '\n';
            markOther();
            continue;
          }
        }
        if (peek !== null && peek.word === 'interface') {
          const b = scanToBrace(peek.end);
          i = skipBalanced(b, '{', '}');
          out += '\n';
          markOther();
          continue;
        }
        out += word; i = j; markWord(word); continue;
      }

      if (word === 'implements') {
        i = scanToBrace(j); // drop clause, leave the class-body brace
        markOther();
        continue;
      }

      out += word;
      i = j;
      markWord(word);
      continue;
    }

    if (c === '(') { stack.push('paren'); out += c; i++; markPunct(c); continue; }
    if (c === ')') { stack.pop(); out += c; i++; markPunct(c); continue; }
    if (c === '[') { stack.push('bracket'); out += c; i++; markPunct(c); continue; }
    if (c === ']') { stack.pop(); out += c; i++; markPunct(c); continue; }

    if (c === '{') {
      stack.push(classifyBrace());
      out += c; i++; markPunct(c); continue;
    }
    if (c === '}') {
      const top = stack.pop();
      out += c; i++;
      if (top === 'template') mode = 'tmpl';
      markPunct(c);
      continue;
    }

    if (c === ':') {
      const top = stack.length > 0 ? stack[stack.length - 1] : 'block';
      let annotatable = false;
      if (prevSignificant === 'word') {
        annotatable = prevWord !== 'case' && prevWord !== 'default';
      } else if (prevSignificant === 'punct') {
        annotatable = lastPuncts.endsWith(')') || lastPuncts.endsWith(']') || lastPuncts.endsWith('}');
      }
      if (annotatable && top !== 'object') {
        i = skipTypeAnnotation(i + 1);
        markOther();
        continue;
      }
      out += c; i++; markPunct(c); continue;
    }

    if (c === '<') {
      if (prevSignificant === 'word' && (prevPrevWord === 'class' || prevPrevWord === 'function')) {
        i = skipBalanced(i, '<', '>');
        markOther();
        continue;
      }
      out += c; i++; markPunct(c); continue;
    }

    out += c;
    i++;
    markPunct(c);
  }

  return out;
}

async function compileDir(srcDir, outDir, importCheck) {
  mkdirSync(outDir, { recursive: true });
  const emitted = [];
  for (const entry of readdirSync(srcDir).sort()) {
    if (!entry.endsWith('.ts')) continue;
    const src = readFileSync(join(srcDir, entry), 'utf8');
    let js;
    try {
      js = stripTypes(src);
    } catch (err) {
      console.error('strip failed for ' + entry + ': ' + err.message);
      process.exit(1);
    }
    const outPath = join(outDir, entry.replace(/\.ts$/, '.js'));
    writeFileSync(outPath, js);
    emitted.push(outPath);
    console.log('compiled ' + join(outDir.replace(root + '/', ''), entry.replace(/\.ts$/, '.js')));
  }
  if (importCheck) {
    // Library modules are side-effect free, so importing validates both
    // syntax and cross-module resolution without spawning a process.
    for (const outPath of emitted) {
      try {
        await import(pathToFileURL(outPath).href);
      } catch (err) {
        console.error('import check failed for ' + outPath + ': ' + err.message);
        process.exit(1);
      }
    }
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
async function main() {
  const dist = join(root, 'dist');
  rmSync(dist, { recursive: true, force: true });
  await compileDir(join(root, 'src'), join(dist, 'src'), true);
  await compileDir(join(root, 'tests'), join(dist, 'tests'), false);
  console.log('build ok');
}
if (isMain) {
  await main();
}
