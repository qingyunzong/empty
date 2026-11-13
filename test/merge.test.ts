import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeDocuments } from "../index.js";
import type { JsonApiDocument } from "../index.js";

describe("mergeDocuments", () => {
  it("keys the graph by type+id across data and included", () => {
    const doc: JsonApiDocument = {
      data: {
        type: "articles",
        id: "1",
        attributes: { title: "Hello" },
        relationships: { author: { data: { type: "people", id: "9" } } },
      },
      included: [
        { type: "people", id: "9", attributes: { name: "Ada" } },
        { type: "people", id: "9", attributes: { name: "Ignored same-gen loser" } },
      ],
    };
    const graph = mergeDocuments([doc]);
    assert.equal(graph.size, 2);
    assert.equal(graph.get("articles", "1")?.attributes.get("title")?.value, "Hello");
    assert.equal(graph.get("people", "9")?.attributes.get("name")?.value, "Ada");
  });

  it("resolves attribute conflicts by source generation, field by field", () => {
    const older: JsonApiDocument = {
      data: { type: "articles", id: "1", attributes: { title: "Old", body: "keep me" } },
    };
    const newer: JsonApiDocument = {
      data: { type: "articles", id: "1", attributes: { title: "New" } },
    };
    const graph = mergeDocuments([older, newer], { generations: [1, 2] });
    const node = graph.get("articles", "1")!;
    assert.equal(node.attributes.get("title")?.value, "New");
    assert.equal(node.attributes.get("body")?.value, "keep me");

    const flipped = mergeDocuments([older, newer], { generations: [2, 1] });
    assert.equal(flipped.get("articles", "1")!.attributes.get("title")?.value, "Old");
  });

  it("records a source pointer for every field", () => {
    const graph = mergeDocuments(
      [
        { data: { type: "articles", id: "1", attributes: { title: "A" } } },
        { included: [{ type: "articles", id: "1", attributes: { title: "B" } }] },
      ],
      { generations: [0, 1] },
    );
    assert.deepEqual(graph.fieldSource("articles", "1", "title"), {
      documentIndex: 1,
      generation: 1,
      pointer: "/included/0/attributes/title",
    });
  });

  it("never fabricates nodes for missing linkage", () => {
    const graph = mergeDocuments([
      {
        data: {
          type: "articles",
          id: "1",
          relationships: {
            author: { links: { related: "/articles/1/author" } },
            tags: { data: [{ type: "tags", id: "404" }] },
          },
        },
      },
    ]);
    const node = graph.get("articles", "1")!;
    assert.equal(graph.related(node, "author").length, 0);
    assert.equal(graph.related(node, "tags").length, 0);
    assert.equal(graph.size, 1);
    assert.equal(graph.get("tags", "404"), undefined);
  });

  it("supports cyclic queries and deterministic serialization", () => {
    const doc: JsonApiDocument = {
      data: [
        {
          type: "nodes",
          id: "a",
          relationships: { next: { data: { type: "nodes", id: "b" } } },
        },
        {
          type: "nodes",
          id: "b",
          relationships: { next: { data: { type: "nodes", id: "a" } } },
        },
      ],
    };
    const graph = mergeDocuments([doc]);
    const a = graph.get("nodes", "a")!;
    assert.equal(graph.related(a, "next")[0].id, "b");
    assert.equal(graph.related(graph.related(a, "next")[0], "next")[0].id, "a");
    assert.deepEqual(
      graph.reachable("nodes", "a").map((n) => n.id),
      ["a", "b"],
    );
    assert.equal(JSON.stringify(graph.toDocument()), JSON.stringify(graph.toDocument()));
    assert.deepEqual(
      (graph.toDocument().data as { id: string }[]).map((r) => r.id),
      ["a", "b"],
    );
  });

  it("applies sparse fieldsets to attributes and relationships", () => {
    const graph = mergeDocuments([
      {
        data: {
          type: "articles",
          id: "1",
          attributes: { title: "T", body: "B" },
          relationships: {
            author: { data: { type: "people", id: "9" } },
            comments: { data: [] },
          },
        },
      },
    ]);
    const doc = graph.toDocument({ fields: { articles: ["title", "author"] } });
    const resource = (doc.data as unknown[])[0] as {
      attributes: Record<string, unknown>;
      relationships: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(resource.attributes), ["title"]);
    assert.deepEqual(Object.keys(resource.relationships), ["author"]);
  });

  it("merges resource-level links and relationship links", () => {
    const graph = mergeDocuments([
      {
        data: {
          type: "articles",
          id: "1",
          links: { self: "/articles/1" },
          relationships: {
            author: { links: { related: "/articles/1/author" } },
          },
        },
      },
    ]);
    const node = graph.get("articles", "1")!;
    assert.equal(node.links.get("self")?.value, "/articles/1");
    assert.equal(
      node.relationships.get("author")?.links.get("related")?.value,
      "/articles/1/author",
    );
    const serialized = graph.toDocument().data as {
      links: Record<string, unknown>;
      relationships: Record<string, { links: Record<string, unknown> }>;
    }[];
    assert.equal(serialized[0].links.self, "/articles/1");
    assert.equal(serialized[0].relationships.author.links.related, "/articles/1/author");
  });

  it("skips resources without a usable identity", () => {
    const graph = mergeDocuments([
      { data: { type: "ghosts", attributes: { boo: true } } as never },
    ]);
    assert.equal(graph.size, 0);
    assert.equal(graph.skipped.length, 1);
  });
});
