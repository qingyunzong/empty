import test from "node:test";
import assert from "node:assert/strict";

import {
  ATOMIC_CHARACTER,
  RangeEditError,
  getLogicalText,
  replaceRange,
  type Anchor,
  type ContainerNode,
  type RichNode,
  type Snapshot,
  type TextNode,
} from "../index.js";

function text(id: string, value: string): TextNode {
  return { type: "text", id, value };
}

function br(id: string): RichNode {
  return { type: "br", id };
}

function atom(id: string): RichNode {
  return { type: "atom", id };
}

function container(id: string, children: RichNode[]): ContainerNode {
  return { type: "container", id, children };
}

function ids(prefix = "generated"): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

function edit(
  snapshot: Snapshot,
  start: Anchor,
  end: Anchor,
  value: string,
  generateId = ids(),
) {
  return replaceRange(
    snapshot,
    { start, end, text: value },
    { expectedVersion: snapshot.version, generateId },
  );
}

function expectError(
  action: () => unknown,
  code: RangeEditError["code"],
): RangeEditError {
  let caught: unknown;

  try {
    action();
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof RangeEditError, "expected RangeEditError");
  assert.equal(caught.code, code);
  return caught;
}

function collect(node: RichNode, result: RichNode[] = []): RichNode[] {
  result.push(node);

  if (node.type === "container") {
    for (const child of node.children) {
      collect(child, result);
    }
  }

  return result;
}

function nodeById(root: ContainerNode, id: string): RichNode | undefined {
  return collect(root).find((node) => node.id === id);
}

function allIds(root: ContainerNode): string[] {
  return collect(root).map((node) => node.id);
}

function assertUniqueIds(root: ContainerNode): void {
  const nodeIds = allIds(root);
  assert.equal(new Set(nodeIds).size, nodeIds.length);
}

function anchorPosition(root: RichNode, anchor: Anchor): number {
  let position = 0;

  const find = (node: RichNode, base: number): number | null => {
    if (node.id === anchor.nodeId) {
      if (node.type === "text") {
        return base + anchor.offset;
      }

      if (node.type === "container") {
        let gap = base;
        for (let index = 0; index < anchor.offset; index += 1) {
          gap += getLogicalText(node.children[index] as RichNode).length;
        }
        return gap;
      }

      throw new Error("anchor points at a non-anchorable node");
    }

    if (node.type === "container") {
      let childBase = base;
      for (const child of node.children) {
        const found = find(child, childBase);
        if (found !== null) {
          return found;
        }
        childBase += getLogicalText(child).length;
      }
    }

    return null;
  };

  const result = find(root, position);
  if (result === null) {
    throw new Error(`anchor node not found: ${anchor.nodeId}`);
  }

  return result;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function assertRetainedMapping(oldText: string, newText: string, mapping: readonly (number | null)[]): void {
  assert.equal(mapping.length, newText.length);
  for (let index = 0; index < mapping.length; index += 1) {
    const oldOffset = mapping[index];
    if (oldOffset !== null) {
      assert.equal(newText[index], oldText[oldOffset]);
    }
  }
}

test("跨嵌套容器替换并保留未删除节点身份", () => {
  const t1 = text("t1", "ab");
  const t2 = text("t2", "cd");
  const t3 = text("t3", "ef");
  const t4 = text("t4", "gh");
  const t5 = text("t5", "ij");
  const br1 = br("br1");
  const br2 = br("br2");
  const c2 = container("c2", [t3, br1, t4]);
  const c1 = container("c1", [t2, c2, br2]);
  const root = container("root", [t1, c1, t5]);
  const snapshot: Snapshot = { version: 7, root };

  const oldText = getLogicalText(root);
  assert.equal(oldText, "abcdef\ngh\nij");

  const result = edit(
    snapshot,
    { nodeId: "t2", offset: 1 },
    { nodeId: "t4", offset: 1 },
    "X",
  );

  assert.equal(getLogicalText(result.tree), "abcXh\nij");
  assert.equal(result.snapshot.version, 7);
  assert.equal(result.normalizedRange.start, 3);
  assert.equal(result.normalizedRange.end, 8);

  assert.equal(nodeById(result.tree, "t1"), t1);
  assert.equal(nodeById(result.tree, "br2"), br2);
  assert.equal(nodeById(result.tree, "t5"), t5);
  assert.equal((nodeById(result.tree, "t2") as TextNode).value, "c");
  assert.equal((nodeById(result.tree, "t4") as TextNode).value, "h");
  assert.equal(nodeById(result.tree, "t3"), undefined);
  assert.equal(nodeById(result.tree, "br1"), undefined);

  for (const containerId of ["root", "c1", "c2"]) {
    assert.equal(nodeById(result.tree, containerId)?.type, "container");
  }

  assert.deepEqual(result.mapping, [0, 1, 2, null, 8, 9, 10, 11]);
  assert.equal(result.retainedCharacters.length, 7);
  assertRetainedMapping(oldText, getLogicalText(result.tree), result.mapping);

  assert.equal(result.cursor.nodeId, (nodeById(result.tree, result.cursor.nodeId) as TextNode).id);
  assert.equal((nodeById(result.tree, result.cursor.nodeId) as TextNode).value, "X");
  assert.equal(result.cursor.offset, 1);
  assert.equal(
    anchorPosition(result.tree, result.cursor),
    result.normalizedRange.start + "X".length,
  );
});

test("文本内部空范围插入会拆分原文本并保留原ID", () => {
  const t1 = text("t1", "abcd");
  const snapshot: Snapshot = { version: 1, root: container("root", [t1]) };

  const result = edit(
    snapshot,
    { nodeId: "t1", offset: 2 },
    { nodeId: "t1", offset: 2 },
    "XY",
  );

  assert.equal(getLogicalText(result.tree), "abXYcd");
  assert.deepEqual(result.normalizedRange, { start: 2, end: 2 });

  const children = result.tree.children;
  assert.equal(children.length, 3);
  assert.equal((children[0] as TextNode).id, "t1");
  assert.equal((children[0] as TextNode).value, "ab");
  assert.equal((children[1] as TextNode).id, result.cursor.nodeId);
  assert.equal((children[1] as TextNode).value, "XY");
  assert.equal((children[2] as TextNode).value, "cd");
  assert.notEqual((children[2] as TextNode).id, "t1");
  assert.equal(t1.value, "abcd");
  assert.equal(anchorPosition(result.tree, result.cursor), 4);

  assert.deepEqual(result.mapping, [0, 1, null, null, 2, 3]);
  assertRetainedMapping("abcd", "abXYcd", result.mapping);
  assertUniqueIds(result.tree);
});

test("容器间隙插入并与空容器共存", () => {
  const t1 = text("t1", "a");
  const t2 = text("t2", "b");
  const t3 = text("t3", "c");
  const emptyContainer = container("empty", []);
  const c1 = container("c1", [t1, t2, emptyContainer]);
  const root = container("root", [c1, t3]);
  const snapshot: Snapshot = { version: 1, root };

  const result = edit(
    snapshot,
    { nodeId: "c1", offset: 1 },
    { nodeId: "c1", offset: 1 },
    "Z",
  );

  assert.equal(getLogicalText(result.tree), "aZbc");
  const editedC1 = nodeById(result.tree, "c1") as ContainerNode;
  assert.equal(editedC1.children.length, 4);
  assert.equal(editedC1.children[0], t1);
  assert.equal((editedC1.children[1] as TextNode).value, "Z");
  assert.equal(editedC1.children[2], t2);
  assert.equal(editedC1.children[3], emptyContainer);
  assert.equal(nodeById(result.tree, "t1"), t1);
  assert.equal(nodeById(result.tree, "t2"), t2);
  assert.equal(nodeById(result.tree, "empty"), emptyContainer);
  assert.equal(anchorPosition(result.tree, result.cursor), 2);
  assert.deepEqual(result.mapping, [0, null, 1, 2]);
});

test("代理对替换成功且锚点不得切断代理对", () => {
  const t1 = text("t1", "A😀B");
  const snapshot: Snapshot = { version: 3, root: container("root", [t1]) };

  const result = edit(
    snapshot,
    { nodeId: "t1", offset: 1 },
    { nodeId: "t1", offset: 3 },
    "🙂",
  );

  assert.equal(getLogicalText(result.tree), "A🙂B");
  assert.equal((nodeById(result.tree, "t1") as TextNode).value, "A");
  assert.equal(result.cursor.offset, 2);
  assert.equal(anchorPosition(result.tree, result.cursor), 3);
  assert.deepEqual(result.mapping, [0, null, null, 3]);
  assertRetainedMapping("A😀B", "A🙂B", result.mapping);

  const before = JSON.stringify(snapshot);
  expectError(
    () =>
      edit(
        snapshot,
        { nodeId: "t1", offset: 1 },
        { nodeId: "t1", offset: 2 },
        "x",
      ),
    "SPLIT_SURROGATE",
  );
  expectError(
    () =>
      edit(
        snapshot,
        { nodeId: "t1", offset: 2 },
        { nodeId: "t1", offset: 3 },
        "x",
      ),
    "SPLIT_SURROGATE",
  );
  assert.equal(JSON.stringify(snapshot), before);
});

test("只删除br时新空文本节点仍存在", () => {
  const t1 = text("t1", "a");
  const b1 = br("b1");
  const t2 = text("t2", "b");
  const root = container("root", [t1, b1, t2]);
  const snapshot: Snapshot = { version: "v1", root };

  const result = edit(
    snapshot,
    { nodeId: "root", offset: 1 },
    { nodeId: "root", offset: 2 },
    "",
  );

  assert.equal(getLogicalText(result.tree), "ab");
  assert.equal(result.tree.children.length, 3);
  assert.equal(result.tree.children[0], t1);
  assert.equal((result.tree.children[1] as TextNode).value, "");
  assert.equal(
    (result.tree.children[1] as TextNode).id,
    result.cursor.nodeId,
  );
  assert.equal(result.tree.children[2], t2);
  assert.equal(nodeById(result.tree, "b1"), undefined);
  assert.equal(result.cursor.offset, 0);
  assert.equal(anchorPosition(result.tree, result.cursor), 1);
  assert.deepEqual(result.mapping, [0, 2]);
});

test("原子边界可插入，跨过原子字符整次拒绝", () => {
  const t1 = text("t1", "a");
  const a1 = atom("a1");
  const t2 = text("t2", "b");
  const root = container("root", [t1, a1, t2]);
  const snapshot: Snapshot = { version: 2, root };

  assert.equal(getLogicalText(root), `a${ATOMIC_CHARACTER}b`);

  const beforeAtom = edit(
    snapshot,
    { nodeId: "root", offset: 1 },
    { nodeId: "root", offset: 1 },
    "X",
  );
  assert.equal(getLogicalText(beforeAtom.tree), `aX${ATOMIC_CHARACTER}b`);
  assert.equal(nodeById(beforeAtom.tree, "a1"), a1);
  assert.deepEqual(beforeAtom.mapping, [0, null, 1, 2]);

  const afterAtom = edit(
    snapshot,
    { nodeId: "root", offset: 2 },
    { nodeId: "root", offset: 2 },
    "Y",
  );
  assert.equal(getLogicalText(afterAtom.tree), `a${ATOMIC_CHARACTER}Yb`);
  assert.equal(nodeById(afterAtom.tree, "a1"), a1);
  assert.deepEqual(afterAtom.mapping, [0, 1, null, 2]);

  const before = JSON.stringify(snapshot);
  expectError(
    () =>
      edit(
        snapshot,
        { nodeId: "root", offset: 1 },
        { nodeId: "root", offset: 2 },
        "X",
      ),
    "ATOM_IN_RANGE",
  );
  assert.equal(JSON.stringify(snapshot), before);
  assert.equal(nodeById(snapshot.root, "a1"), a1);
});

test("起始文本被完全覆盖时保留空左半与原ID", () => {
  const t1 = text("t1", "abc");
  const t2 = text("t2", "def");
  const root = container("root", [t1, t2]);
  const snapshot: Snapshot = { version: 1, root };

  const result = edit(
    snapshot,
    { nodeId: "t1", offset: 0 },
    { nodeId: "t2", offset: 2 },
    "X",
  );

  assert.equal(getLogicalText(result.tree), "Xf");
  assert.equal((nodeById(result.tree, "t1") as TextNode).value, "");
  assert.equal((nodeById(result.tree, "t2") as TextNode).value, "f");
  assert.equal(nodeById(result.tree, "t1")?.id, "t1");
  assert.equal(nodeById(result.tree, "t2")?.id, "t2");
  assert.equal(t1.value, "abc");
  assert.equal(t2.value, "def");
  assert.deepEqual(result.mapping, [null, 5]);
  assert.equal(anchorPosition(result.tree, result.cursor), 1);
});

test("起点容器间隙在删除兄弟文本后仍属于原容器", () => {
  const t1 = text("t1", "a");
  const t2 = text("t2", "b");
  const t3 = text("t3", "c");
  const t4 = text("t4", "d");
  const c1 = container("c1", [t1, t2, t3]);
  const root = container("root", [c1, t4]);
  const snapshot: Snapshot = { version: 1, root };

  const result = edit(
    snapshot,
    { nodeId: "c1", offset: 1 },
    { nodeId: "c1", offset: 3 },
    "X",
  );

  assert.equal(getLogicalText(result.tree), "aXd");
  const editedC1 = nodeById(result.tree, "c1") as ContainerNode;
  assert.equal(editedC1.children.length, 2);
  assert.equal(editedC1.children[0], t1);
  assert.equal(editedC1.children[1], nodeById(result.tree, result.cursor.nodeId));
  assert.equal((editedC1.children[1] as TextNode).value, "X");
  assert.equal(nodeById(result.tree, "t2"), undefined);
  assert.equal(nodeById(result.tree, "t3"), undefined);
  assert.equal(nodeById(result.tree, "t4"), t4);
  assert.deepEqual(result.mapping, [0, null, 3]);
});

test("空文本除起始文本外删除，空容器保留且节点身份稳定", () => {
  const emptyBefore = text("empty-before", "");
  const t1 = text("t1", "a");
  const emptyAfter = text("empty-after", "");
  const emptyContainer = container("empty-container", []);
  const root = container("root", [emptyBefore, t1, emptyAfter, emptyContainer]);
  const snapshot: Snapshot = { version: 1, root };

  const result = edit(
    snapshot,
    { nodeId: "t1", offset: 1 },
    { nodeId: "t1", offset: 1 },
    "Z",
  );

  assert.equal(getLogicalText(result.tree), "aZ");
  assert.equal(nodeById(result.tree, "empty-before"), undefined);
  assert.equal(nodeById(result.tree, "empty-after"), undefined);
  assert.equal(nodeById(result.tree, "t1"), t1);
  assert.equal(nodeById(result.tree, "empty-container"), emptyContainer);
  assert.deepEqual(result.tree.children.map((node) => node.id), [
    "t1",
    result.cursor.nodeId,
    "empty-container",
  ]);
});

test("起始文本自身为空时仍保留该起始节点", () => {
  const start = text("start-empty", "");
  const after = text("after", "a");
  const root = container("root", [start, after]);
  const snapshot: Snapshot = { version: 1, root };

  const result = edit(
    snapshot,
    { nodeId: "start-empty", offset: 0 },
    { nodeId: "start-empty", offset: 0 },
    "",
  );

  assert.equal(getLogicalText(result.tree), "a");
  assert.equal(nodeById(result.tree, "start-empty"), start);
  assert.equal((result.tree.children[0] as TextNode).value, "");
  assert.equal((result.tree.children[1] as TextNode).value, "");
  assert.equal((result.tree.children[1] as TextNode).id, result.cursor.nodeId);
});

test("版本、锚点、顺序、原子与ID冲突均拒绝且不修改快照", () => {
  const t1 = text("t1", "abcd");
  const a1 = atom("a1");
  const b1 = br("b1");
  const nested = container("nested", [t1, b1, a1]);
  const snapshot = deepFreeze<Snapshot>({
    version: 4,
    root: container("root", [nested]),
  });

  let generatorCalls = 0;
  const generator = () => {
    generatorCalls += 1;
    return "fresh";
  };

  expectError(
    () =>
      replaceRange(
        snapshot,
        {
          start: { nodeId: "t1", offset: 0 },
          end: { nodeId: "t1", offset: 1.5 },
          text: "x",
        },
        { expectedVersion: 5, generateId: generator },
      ),
    "VERSION_MISMATCH",
  );
  assert.equal(generatorCalls, 0);

  expectError(
    () =>
      replaceRange(
        snapshot,
        {
          start: { nodeId: "t1", offset: 0 },
          end: { nodeId: "t1", offset: 1.5 },
          text: "x",
        },
        { expectedVersion: 4, generateId: generator },
      ),
    "INVALID_ANCHOR",
  );

  expectError(
    () => edit(snapshot, { nodeId: "missing", offset: 0 }, { nodeId: "t1", offset: 0 }, "x"),
    "INVALID_ANCHOR",
  );
  assert.equal(generatorCalls, 0);

  expectError(
    () => edit(snapshot, { nodeId: "b1", offset: 0 }, { nodeId: "t1", offset: 0 }, "x"),
    "INVALID_ANCHOR",
  );
  expectError(
    () => edit(snapshot, { nodeId: "a1", offset: 0 }, { nodeId: "t1", offset: 0 }, "x"),
    "INVALID_ANCHOR",
  );
  expectError(
    () => edit(snapshot, { nodeId: "t1", offset: 3 }, { nodeId: "t1", offset: 1 }, "x"),
    "UNORDERED_RANGE",
  );
  expectError(
    () =>
      edit(
        snapshot,
        { nodeId: "t1", offset: 4 },
        { nodeId: "nested", offset: 3 },
        "x",
      ),
    "ATOM_IN_RANGE",
  );
  assert.equal(generatorCalls, 0);

  expectError(
    () => edit(snapshot, { nodeId: "t1", offset: 0 }, { nodeId: "t1", offset: 1 }, "x", () => "t1"),
    "ID_COLLISION",
  );

  let duplicate = 0;
  expectError(
    () =>
      edit(
        snapshot,
        { nodeId: "t1", offset: 2 },
        { nodeId: "t1", offset: 2 },
        "x",
        () => (++duplicate === 1 ? "fresh-a" : "fresh-a"),
      ),
    "ID_COLLISION",
  );

  assert.equal(JSON.stringify(snapshot), JSON.stringify({
    version: 4,
    root: {
      type: "container",
      id: "root",
      children: [{
        type: "container",
        id: "nested",
        children: [
          { type: "text", id: "t1", value: "abcd" },
          { type: "br", id: "b1" },
          { type: "atom", id: "a1" },
        ],
      }],
    },
  }));
});

test("逻辑串公式覆盖嵌套范围、空范围与容器锚点", () => {
  const first = text("first", "a");
  const emoji = text("emoji", "C😀D");
  const afterBreak = text("after-break", "E");
  const tail = text("tail", "F");
  const lineBreak = br("line-break");
  const inner = container("inner", [emoji, lineBreak, afterBreak]);
  const root = container("root", [first, inner, tail]);
  const oldText = getLogicalText(root);
  const snapshot: Snapshot = { version: 1, root };

  const anchors: Array<{ anchor: Anchor; position: number }> = [
    { anchor: { nodeId: "first", offset: 0 }, position: 0 },
    { anchor: { nodeId: "first", offset: 1 }, position: 1 },
    { anchor: { nodeId: "emoji", offset: 0 }, position: 1 },
    { anchor: { nodeId: "emoji", offset: 1 }, position: 2 },
    { anchor: { nodeId: "emoji", offset: 3 }, position: 4 },
    { anchor: { nodeId: "emoji", offset: 4 }, position: 5 },
    { anchor: { nodeId: "after-break", offset: 0 }, position: 6 },
    { anchor: { nodeId: "after-break", offset: 1 }, position: 7 },
    { anchor: { nodeId: "tail", offset: 0 }, position: 7 },
    { anchor: { nodeId: "tail", offset: 1 }, position: 8 },
    { anchor: { nodeId: "inner", offset: 0 }, position: 1 },
    { anchor: { nodeId: "inner", offset: 1 }, position: 5 },
    { anchor: { nodeId: "inner", offset: 2 }, position: 6 },
    { anchor: { nodeId: "inner", offset: 3 }, position: 7 },
    { anchor: { nodeId: "root", offset: 0 }, position: 0 },
    { anchor: { nodeId: "root", offset: 1 }, position: 1 },
    { anchor: { nodeId: "root", offset: 2 }, position: 7 },
    { anchor: { nodeId: "root", offset: 3 }, position: 8 },
  ];

  for (const start of anchors) {
    for (const end of anchors) {
      if (start.position > end.position) {
        continue;
      }

      const result = edit(snapshot, start.anchor, end.anchor, "Q");
      assert.equal(
        getLogicalText(result.tree),
        oldText.slice(0, start.position) + "Q" + oldText.slice(end.position),
        `${JSON.stringify(start.anchor)} -> ${JSON.stringify(end.anchor)}`,
      );
      assertUniqueIds(result.tree);
      assert.equal(
        anchorPosition(result.tree, result.cursor),
        start.position + 1,
      );
    }
  }
});

test("非法树、非法文本与ID生成失败均拒绝", () => {
  const shared = text("shared", "a");
  expectError(
    () =>
      edit(
        { version: 1, root: container("root", [shared, shared]) },
        { nodeId: "shared", offset: 0 },
        { nodeId: "shared", offset: 0 },
        "x",
      ),
    "INVALID_SNAPSHOT",
  );

  expectError(
    () =>
      edit(
        {
          version: 1,
          root: container("root", [text("dup", "a"), text("dup", "b")]),
        },
        { nodeId: "dup", offset: 0 },
        { nodeId: "dup", offset: 0 },
        "x",
      ),
    "INVALID_SNAPSHOT",
  );

  expectError(
    () =>
      edit(
        { version: 1, root: container("root", [text("bad", "\uD800")]) },
        { nodeId: "bad", offset: 0 },
        { nodeId: "bad", offset: 0 },
        "x",
      ),
    "INVALID_SNAPSHOT",
  );

  const valid: Snapshot = {
    version: 1,
    root: container("root", [text("t1", "a")]),
  };
  expectError(
    () =>
      edit(
        valid,
        { nodeId: "t1", offset: 0 },
        { nodeId: "t1", offset: 0 },
        "\uD800",
      ),
    "INVALID_TEXT",
  );
  expectError(
    () =>
      edit(
        valid,
        { nodeId: "t1", offset: 0 },
        { nodeId: "t1", offset: 0 },
        "x",
        () => "",
      ),
    "INVALID_ID",
  );
  expectError(
    () =>
      edit(
        valid,
        { nodeId: "t1", offset: 0 },
        { nodeId: "t1", offset: 0 },
        "x",
        () => {
          throw new Error("generator failure");
        },
      ),
    "ID_GENERATION_FAILED",
  );
});
