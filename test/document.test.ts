import test from 'node:test';
import assert from 'node:assert/strict';
import { Document } from '../src/document.js';

test('parses headings and paragraphs; definition lines are not output', () => {
  const doc = new Document(
    ['# Title', '', 'first paragraph', 'still same paragraph', '', '[a]: https://a.example "A"', 'after def'].join('\n'),
  );
  const nodes = doc.getNodes();
  assert.deepEqual(
    nodes.map((n) => n.kind),
    ['heading', 'paragraph', 'paragraph'],
  );
  assert.equal(nodes[0].level, 1);
  assert.equal(nodes[1].text, 'first paragraph\nstill same paragraph');
  assert.equal(nodes[2].text, 'after def');
});

test('a reference resolves to the LAST definition of its id', () => {
  const doc = new Document(
    ['[a]: https://first.example', '', 'see [the link][a] here', '', '[a]: https://last.example "Last"'].join('\n'),
  );
  const para = doc.getNodes().find((n) => n.kind === 'paragraph')!;
  assert.deepEqual(para.links, [{ text: 'the link', id: 'a', url: 'https://last.example', title: 'Last' }]);
});

test('collapsed reference [id][] uses the text as id; ids are case-insensitive', () => {
  const doc = new Document(['[My Site][]', '', '[my site]: https://mysite.example'].join('\n'));
  const para = doc.getNodes()[0];
  assert.deepEqual(para.refs, ['my site']);
  assert.equal(para.links[0].url, 'https://mysite.example');
});

test('unresolved references have no url', () => {
  const doc = new Document('see [x][nope]');
  assert.deepEqual(doc.getNodes()[0].links, [{ text: 'x', id: 'nope' }]);
});

test('source ranges slice back the exact node text', () => {
  const source = ['## Head', '', 'para one', '', '[d]: /d', 'tail [r][d]'].join('\n');
  const doc = new Document(source);
  for (const node of doc.getNodes()) {
    assert.equal(source.slice(node.start, node.end), node.text);
    assert.equal(source.split('\n').slice(node.startLine, node.endLine).join('\n'), node.text);
  }
});

test('editing a definition updates only its referencing nodes', () => {
  const doc = new Document(
    [
      'uses [one][a] here', // line 0, node 1
      '',
      'uses [two][b] here', // line 2, node 2
      '',
      '[a]: https://a1.example', // line 4
      '[b]: https://b1.example', // line 5
    ].join('\n'),
  );
  const [nodeA, nodeB] = doc.getNodes();
  const result = doc.applyEdit(4, 1, ['[a]: https://a2.example "new"']);

  assert.deepEqual(result.changedDefinitions, ['a']);
  assert.deepEqual(result.updatedNodeIds, [nodeA.id], 'only the node referencing [a] is updated');
  assert.deepEqual(result.removedNodeIds, []);
  assert.equal(result.reparsedLines, 1, 'only the definition line is re-parsed');

  const after = doc.getNodes();
  assert.equal(after[0].id, nodeA.id);
  assert.deepEqual(after[0].links, [{ text: 'one', id: 'a', url: 'https://a2.example', title: 'new' }]);
  assert.equal(after[1].id, nodeB.id);
  assert.deepEqual(after[1].links, [{ text: 'two', id: 'b', url: 'https://b1.example' }]);
  assert.equal(doc.getDefinitions().get('a')!.url, 'https://a2.example');
});

test('editing a shadowed (non-last) definition changes nothing', () => {
  const doc = new Document(
    ['[a]: https://shadowed.example', '', 'ref [x][a]', '', '[a]: https://active.example'].join('\n'),
  );
  const result = doc.applyEdit(0, 1, ['[a]: https://still-shadowed.example']);
  assert.deepEqual(result.changedDefinitions, []);
  assert.deepEqual(result.updatedNodeIds, []);
  assert.equal(doc.getNodes()[0].links[0].url, 'https://active.example');
});

test('deleting the last definition falls back to the previous one', () => {
  const doc = new Document(
    ['[a]: https://first.example', '', 'ref [x][a]', '', '[a]: https://second.example'].join('\n'),
  );
  const nodeId = doc.getNodes()[0].id;
  const result = doc.applyEdit(4, 1, []);
  assert.deepEqual(result.changedDefinitions, ['a']);
  assert.deepEqual(result.updatedNodeIds, [nodeId]);
  assert.equal(doc.getNodes()[0].links[0].url, 'https://first.example');
});

test('deleting the only definition makes the reference unresolved', () => {
  const doc = new Document(['ref [x][a]', '', '[a]: https://a.example'].join('\n'));
  const nodeId = doc.getNodes()[0].id;
  const result = doc.applyEdit(2, 1, []);
  assert.deepEqual(result.changedDefinitions, ['a']);
  assert.deepEqual(result.updatedNodeIds, [nodeId]);
  assert.deepEqual(doc.getNodes()[0].links, [{ text: 'x', id: 'a' }]);
  assert.equal(doc.getDefinitions().has('a'), false);
});

test('inserting lines above keeps source ranges accurate', () => {
  const doc = new Document(['# T', '', 'body [x][a]', '', '[a]: /a'].join('\n'));
  doc.applyEdit(0, 0, ['inserted one', 'inserted two', '']);
  const text = doc.getText();
  for (const node of doc.getNodes()) {
    assert.equal(text.slice(node.start, node.end), node.text);
  }
  const body = doc.getNodes().find((n) => n.text.startsWith('body'))!;
  assert.equal(body.startLine, 5);
  assert.equal(body.links[0].url, '/a');
});

test('removing the blank line between two paragraphs merges them', () => {
  const doc = new Document(['aaa', '', 'bbb'].join('\n'));
  const oldIds = doc.getNodes().map((n) => n.id);
  const result = doc.applyEdit(1, 1, []);
  const nodes = doc.getNodes();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].text, 'aaa\nbbb');
  assert.deepEqual(result.removedNodeIds, oldIds);
  assert.deepEqual(result.updatedNodeIds, [nodes[0].id]);
});

test('splitting a paragraph with a blank line yields two paragraphs', () => {
  const doc = new Document(['aaa', 'bbb', 'ccc'].join('\n'));
  doc.applyEdit(1, 1, ['']);
  const nodes = doc.getNodes();
  assert.deepEqual(nodes.map((n) => n.text), ['aaa', 'ccc']);
});

test('dependencies map tracks referencing nodes per definition id', () => {
  const doc = new Document(
    ['p1 [x][a] and [y][b]', '', 'p2 [z][a]', '', '[a]: /a', '[b]: /b'].join('\n'),
  );
  const [n1, n2] = doc.getNodes();
  const deps = doc.getDependencies();
  assert.deepEqual([...deps.get('a')!].sort(), [n1.id, n2.id].sort());
  assert.deepEqual([...deps.get('b')!], [n1.id]);
});
