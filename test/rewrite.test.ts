import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ArchiveRewriteError,
  rewriteArchiveLinks,
} from "../index.js";
import type {
  ArchiveNode,
  ManifestEntry,
  RewriteInput,
  TagAttributePair,
} from "../index.js";

const ALLOWED: TagAttributePair[] = [
  { tag: "a", attribute: "href" },
  { tag: "img", attribute: "src" },
  { tag: "link", attribute: "href" },
  { tag: "script", attribute: "src" },
];

function node(
  id: string,
  tag: string,
  attributes: Record<string, string> = {},
  children: ArchiveNode[] = [],
): ArchiveNode {
  return { id, tag, attributes, children };
}

function snapshot(value: unknown): string {
  return JSON.stringify(value);
}

function child(parent: ArchiveNode, index: number): ArchiveNode {
  const found = parent.children[index];
  assert.ok(found, `缺少第 ${index} 个子节点`);
  return found;
}

test("base 出现在资源之后时仍作为全页解析基准", () => {
  const tree = node("html", "html", {}, [
    node("body", "body", {}, [
      node("link1", "a", { href: "a.html?x=1#frag" }),
      node("img1", "img", { src: "/img/p.png" }),
      node("b1", "base", { href: "https://cdn.example.com/sub/" }),
    ]),
  ]);
  const manifest: ManifestEntry[] = [
    {
      uri: "https://cdn.example.com/sub/a.html?x=1",
      localPath: "cdn/a.html",
    },
    {
      uri: "https://cdn.example.com/img/p.png",
      localPath: "cdn/img/p.png",
    },
  ];

  const result = rewriteArchiveLinks({
    tree,
    responseUrl: "https://example.com/page/index.html",
    manifest,
    allowed: ALLOWED,
  });

  const body = child(result.tree, 0);
  assert.equal(child(body, 0).attributes.href, "cdn/a.html#frag");
  assert.equal(child(body, 1).attributes.src, "cdn/img/p.png");
  assert.deepEqual(result.replacements, [
    { nodeId: "link1", attribute: "href", originalValue: "a.html?x=1#frag" },
    { nodeId: "img1", attribute: "src", originalValue: "/img/p.png" },
  ]);
  assert.deepEqual(result.missedUris, []);
});

test("片段：命中时原样附回，仅片段与 data: 保持原值且不记未命中", () => {
  const tree = node("root", "html", {}, [
    node("f1", "a", { href: "#section" }),
    node("f2", "a", { href: "page2.html#part2" }),
    node("f3", "a", { href: "https://example.com/dir/missing.html#z" }),
    node("f4", "a", { href: "data:text/plain,hello" }),
    node("f5", "a", { href: "data:text/html,%3Cp%3Ex%3C%2Fp%3E#f" }),
    node("f6", "a", { href: "page3.html#" }),
  ]);
  const manifest: ManifestEntry[] = [
    { uri: "https://example.com/dir/page2.html", localPath: "p2.html" },
    { uri: "https://example.com/dir/page3.html", localPath: "local3.html" },
  ];

  const result = rewriteArchiveLinks({
    tree,
    responseUrl: "https://example.com/dir/page.html",
    manifest,
    allowed: ALLOWED,
  });

  assert.equal(child(result.tree, 0).attributes.href, "#section");
  assert.equal(child(result.tree, 1).attributes.href, "p2.html#part2");
  assert.equal(
    child(result.tree, 2).attributes.href,
    "https://example.com/dir/missing.html#z",
  );
  assert.equal(child(result.tree, 3).attributes.href, "data:text/plain,hello");
  assert.equal(
    child(result.tree, 4).attributes.href,
    "data:text/html,%3Cp%3Ex%3C%2Fp%3E#f",
  );
  assert.equal(child(result.tree, 5).attributes.href, "local3.html#");
  assert.deepEqual(result.missedUris, [
    "https://example.com/dir/missing.html",
  ]);
  assert.deepEqual(
    result.replacements.map((item) => item.nodeId),
    ["f2", "f6"],
  );
});

test("空 href 相对基准解析为页面自身并可被改写", () => {
  const tree = node("root", "html", {}, [
    node("empty", "a", { href: "" }),
  ]);
  const manifest: ManifestEntry[] = [
    {
      uri: "https://example.com/dir/page.html",
      localPath: "self/index.html",
    },
  ];

  const result = rewriteArchiveLinks({
    tree,
    responseUrl: "https://example.com/dir/page.html",
    manifest,
    allowed: ALLOWED,
  });

  assert.equal(child(result.tree, 0).attributes.href, "self/index.html");
  assert.deepEqual(result.replacements, [
    { nodeId: "empty", attribute: "href", originalValue: "" },
  ]);
});

test("空 href 的 base 合法且基准回退为响应 URL", () => {
  const tree = node("root", "html", {}, [
    node("b", "base", { href: "" }),
    node("r", "a", { href: "rel.html" }),
  ]);
  const manifest: ManifestEntry[] = [
    { uri: "https://example.com/dir/rel.html", localPath: "rel/index.html" },
  ];

  const result = rewriteArchiveLinks({
    tree,
    responseUrl: "https://example.com/dir/page.html",
    manifest,
    allowed: ALLOWED,
  });

  assert.equal(child(result.tree, 1).attributes.href, "rel/index.html");
});

test("重复资源引用各自替换并各自记录", () => {
  const tree = node("root", "html", {}, [
    node("d1", "link", { href: "dup.css" }),
    node("d2", "link", { href: "dup.css" }),
    node("d3", "a", { href: "missing1.html" }),
    node("d4", "a", { href: "missing1.html" }),
  ]);
  const manifest: ManifestEntry[] = [
    { uri: "https://example.com/dir/dup.css", localPath: "assets/dup.css" },
  ];

  const result = rewriteArchiveLinks({
    tree,
    responseUrl: "https://example.com/dir/page.html",
    manifest,
    allowed: ALLOWED,
  });

  assert.equal(child(result.tree, 0).attributes.href, "assets/dup.css");
  assert.equal(child(result.tree, 1).attributes.href, "assets/dup.css");
  assert.deepEqual(result.replacements, [
    { nodeId: "d1", attribute: "href", originalValue: "dup.css" },
    { nodeId: "d2", attribute: "href", originalValue: "dup.css" },
  ]);
  assert.deepEqual(result.missedUris, [
    "https://example.com/dir/missing1.html",
    "https://example.com/dir/missing1.html",
  ]);
});

test("首个 base 之后的 base 节点一律忽略，即使其 href 非法", () => {
  const tree = node("root", "html", {}, [
    node("b1", "base", { href: "https://cdn.example.com/" }),
    node("r1", "a", { href: "x.html" }),
    node("b2", "base", { href: "ftp://invalid.example.com/" }),
  ]);
  const manifest: ManifestEntry[] = [
    { uri: "https://cdn.example.com/x.html", localPath: "x/index.html" },
  ];

  const result = rewriteArchiveLinks({
    tree,
    responseUrl: "https://example.com/page.html",
    manifest,
    allowed: ALLOWED,
  });

  assert.equal(child(result.tree, 1).attributes.href, "x/index.html");
});

test("base 非法或非 HTTP/HTTPS 时整页失败", () => {
  const manifest: ManifestEntry[] = [];
  const baseCases = ["http://[::1", "ftp://example.com/", "javascript:alert(1)"];
  for (const href of baseCases) {
    const tree = node("root", "html", {}, [
      node("b", "base", { href }),
      node("r", "a", { href: "rel.html" }),
    ]);
    const before = snapshot(tree);
    assert.throws(
      () =>
        rewriteArchiveLinks({
          tree,
          responseUrl: "https://example.com/page.html",
          manifest,
          allowed: ALLOWED,
        }),
      ArchiveRewriteError,
    );
    assert.equal(snapshot(tree), before, "失败后原树被修改");
  }
});

test("待处理资源 URI 非法时整页失败且不修改原树", () => {
  const tree = node("root", "html", {}, [
    node("ok", "a", { href: "ok.html" }),
    node("bad", "a", { href: "http://[::1" }),
  ]);
  const before = snapshot(tree);

  assert.throws(
    () =>
      rewriteArchiveLinks({
        tree,
        responseUrl: "https://example.com/page.html",
        manifest: [],
        allowed: ALLOWED,
      }),
    ArchiveRewriteError,
  );
  assert.equal(snapshot(tree), before);
  assert.equal(child(tree, 0).attributes.href, "ok.html");
});

test("清单本地路径非法时整页失败", () => {
  const badPaths = [
    "/abs/path.html",
    "back\\slash.html",
    "./dot.html",
    "../parent.html",
    "dir//empty.html",
    "",
  ];
  for (const localPath of badPaths) {
    assert.throws(
      () =>
        rewriteArchiveLinks({
          tree: node("root", "html"),
          responseUrl: "https://example.com/page.html",
          manifest: [{ uri: "https://example.com/a", localPath }],
          allowed: ALLOWED,
        }),
      ArchiveRewriteError,
    );
  }
});

test("响应 URL 非 HTTP/HTTPS 时失败", () => {
  assert.throws(
    () =>
      rewriteArchiveLinks({
        tree: node("root", "html"),
        responseUrl: "ftp://example.com/page.html",
        manifest: [],
        allowed: ALLOWED,
      }),
    ArchiveRewriteError,
  );
});

test("节点 ID 重复时失败且不修改原树", () => {
  const tree = node("root", "html", {}, [
    node("dup", "a", { href: "a.html" }),
    node("dup", "a", { href: "b.html" }),
  ]);
  const before = snapshot(tree);
  assert.throws(
    () =>
      rewriteArchiveLinks({
        tree,
        responseUrl: "https://example.com/page.html",
        manifest: [],
        allowed: ALLOWED,
      }),
    ArchiveRewriteError,
  );
  assert.equal(snapshot(tree), before);
});

test("不在允许列表中的标签属性保持原值且不记未命中", () => {
  const tree = node("root", "html", {}, [
    node("s1", "script", { src: "app.js" }),
    node("a1", "a", { href: "page.html", title: "page.html" }),
  ]);

  const result = rewriteArchiveLinks({
    tree,
    responseUrl: "https://example.com/dir/page.html",
    manifest: [
      { uri: "https://example.com/dir/app.js", localPath: "app/index.js" },
      { uri: "https://example.com/dir/page.html", localPath: "page/index.html" },
    ],
    allowed: [{ tag: "a", attribute: "href" }],
  });

  assert.equal(child(result.tree, 0).attributes.src, "app.js");
  assert.equal(child(result.tree, 1).attributes.href, "page/index.html");
  assert.equal(child(result.tree, 1).attributes.title, "page.html");
  assert.deepEqual(result.missedUris, []);
});

test("输出为不可变新树且成功路径不修改输入树", () => {
  const tree = node("root", "html", {}, [
    node("n1", "a", { href: "a.html" }),
  ]);
  const before = snapshot(tree);

  const result = rewriteArchiveLinks({
    tree,
    responseUrl: "https://example.com/page.html",
    manifest: [
      { uri: "https://example.com/a.html", localPath: "local/a.html" },
    ],
    allowed: ALLOWED,
  });

  assert.equal(snapshot(tree), before);
  assert.notEqual(result.tree, tree);
  assert.notEqual(result.tree.children, tree.children);
  assert.throws(() => {
    result.tree.id = "mutated";
  }, TypeError);
  assert.throws(() => {
    result.tree.children.push(node("x", "x"));
  }, TypeError);
  assert.throws(() => {
    result.replacements.push({
      nodeId: "x",
      attribute: "href",
      originalValue: "x",
    });
  }, TypeError);
  assert.throws(() => {
    result.missedUris.push("https://example.com/x");
  }, TypeError);
});

test("无 base 时使用最终响应 URL 作为基准", () => {
  const input: RewriteInput = {
    tree: node("root", "html", {}, [
      node("n1", "img", { src: "images/logo.png" }),
    ]),
    responseUrl: "https://example.com/site/index.html",
    manifest: [
      {
        uri: "https://example.com/site/images/logo.png",
        localPath: "img/logo.png",
      },
    ],
    allowed: ALLOWED,
  };

  const result = rewriteArchiveLinks(input);
  assert.equal(child(result.tree, 0).attributes.src, "img/logo.png");
});

test("非 HTTP/HTTPS 绝对链接与其它 scheme 保留原值并按规则记录", () => {
  const tree = node("root", "html", {}, [
    node("m1", "a", { href: "mailto:user@example.com" }),
    node("m2", "a", { href: "ftp://files.example.com/data.zip" }),
    node("m3", "a", { href: "https://other.example.com/page" }),
  ]);

  const result = rewriteArchiveLinks({
    tree,
    responseUrl: "https://example.com/dir/page.html",
    manifest: [],
    allowed: ALLOWED,
  });

  assert.equal(child(result.tree, 0).attributes.href, "mailto:user@example.com");
  assert.equal(child(result.tree, 1).attributes.href, "ftp://files.example.com/data.zip");
  assert.equal(child(result.tree, 2).attributes.href, "https://other.example.com/page");
  assert.deepEqual(result.missedUris, [
    "mailto:user@example.com",
    "ftp://files.example.com/data.zip",
    "https://other.example.com/page",
  ]);
  assert.deepEqual(result.replacements, []);
});

test("清单 URI 去片段后与解析后的绝对 URI 精确匹配", () => {
  const tree = node("root", "html", {}, [
    node("q1", "a", { href: "https://example.com/a?b=c&d=e#top" }),
  ]);

  const hit = rewriteArchiveLinks({
    tree,
    responseUrl: "https://example.com/start.html",
    manifest: [
      { uri: "https://example.com/a?b=c&d=e", localPath: "local/query.html" },
    ],
    allowed: ALLOWED,
  });
  assert.equal(child(hit.tree, 0).attributes.href, "local/query.html#top");

  const miss = rewriteArchiveLinks({
    tree,
    responseUrl: "https://example.com/start.html",
    manifest: [
      { uri: "https://example.com/a?b=c&d=f", localPath: "x.html" },
    ],
    allowed: ALLOWED,
  });
  assert.deepEqual(miss.missedUris, ["https://example.com/a?b=c&d=e"]);
  assert.equal(
    child(miss.tree, 0).attributes.href,
    "https://example.com/a?b=c&d=e#top",
  );
});
