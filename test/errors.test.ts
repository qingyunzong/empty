import test from 'node:test';
import assert from 'node:assert/strict';
import { render, parse, TemplateSyntaxError, RenderError } from '../src/index.js';

test('unterminated tag reports the range from "{{" to end of template', () => {
  const template = 'Dear {{user.name';
  assert.throws(
    () => parse(template),
    (err: unknown) => {
      assert.ok(err instanceof TemplateSyntaxError);
      const e = err as TemplateSyntaxError;
      assert.equal(e.start, 5);
      assert.equal(e.end, template.length);
      assert.equal(e.snippet, '{{user.name');
      assert.equal(e.line, 1);
      assert.equal(e.column, 6);
      return true;
    },
  );
});

test('unclosed block reports the open tag range', () => {
  const template = 'A{{#if ok}}B';
  assert.throws(
    () => parse(template),
    (err: unknown) => {
      const e = err as TemplateSyntaxError;
      assert.ok(e instanceof TemplateSyntaxError);
      assert.equal(e.start, 1);
      assert.equal(e.end, 11);
      assert.equal(e.snippet, '{{#if ok}}');
      assert.match(e.message, /Unclosed block/);
      return true;
    },
  );
});

test('mismatched close tag reports both the close and the open range', () => {
  const template = '{{#if a}}x{{/each}}';
  assert.throws(
    () => parse(template),
    (err: unknown) => {
      const e = err as TemplateSyntaxError;
      assert.ok(e instanceof TemplateSyntaxError);
      assert.equal(e.start, 10);
      assert.equal(e.end, 19);
      assert.equal(e.snippet, '{{/each}}');
      assert.deepEqual(e.related, { start: 0, end: 9 });
      assert.equal(template.slice(e.related!.start, e.related!.end), '{{#if a}}');
      assert.match(e.message, /Mismatched close tag/);
      assert.match(e.message, /\{\{\/if\}\}/);
      return true;
    },
  );
});

test('stray close tag without an open block', () => {
  assert.throws(
    () => parse('{{/if}}'),
    (err: unknown) => {
      const e = err as TemplateSyntaxError;
      assert.equal(e.start, 0);
      assert.equal(e.end, 7);
      assert.match(e.message, /without a matching open tag/);
      return true;
    },
  );
});

test('else outside of if, and duplicate else', () => {
  assert.throws(() => parse('{{#each xs}}{{else}}{{/each}}'), /"\{\{else\}\}" without a matching/);
  assert.throws(() => parse('{{#if a}}{{else}}{{else}}{{/if}}'), /Duplicate "\{\{else\}\}"/);
});

test('invalid variable paths and empty tags are rejected', () => {
  assert.throws(() => parse('{{..}}'), /Invalid variable path/);
  assert.throws(() => parse('{{}}'), /Invalid variable path/);
  assert.throws(() => parse('{{#if}}x{{/if}}'), /Invalid block tag/);
});

test('error line and column track the template position', () => {
  const template = 'line1\nline2 {{bad path}}';
  assert.throws(
    () => parse(template),
    (err: unknown) => {
      const e = err as TemplateSyntaxError;
      assert.equal(e.line, 2);
      assert.equal(e.column, 7);
      assert.equal(e.snippet, '{{bad path}}');
      return true;
    },
  );
});

test('render errors carry the offending tag range', () => {
  const template = 'Hi {{missing}}!';
  assert.throws(
    () => render(template, {}),
    (err: unknown) => {
      assert.ok(err instanceof RenderError);
      const e = err as RenderError;
      assert.equal(e.start, 3);
      assert.equal(e.end, 14);
      assert.equal(e.snippet, '{{missing}}');
      assert.equal(e.path, 'missing');
      return true;
    },
  );
});

test('nested error inside a loop reports the inner tag range', () => {
  const template = '{{#each items}}{{#if this.ok}}yes{{/each}}';
  assert.throws(
    () => parse(template),
    (err: unknown) => {
      const e = err as TemplateSyntaxError;
      assert.equal(e.snippet, '{{/each}}');
      assert.equal(template.slice(e.related!.start, e.related!.end), '{{#if this.ok}}');
      return true;
    },
  );
});
