import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  JsonApiMergeConflictError,
  JsonApiParseError,
  buildResourceClosure,
  getResourceKey,
  mergeJsonApiDocuments,
  mergeResources,
  parseJsonApiDocument,
  tryMergeJsonApiDocuments,
} from "../.test-build/index.js";

describe("JSON:API resource merge", () => {
  it("merges sparse representations of the same resource", () => {
    const result = mergeJsonApiDocuments({
      data: {
        type: "articles",
        id: "1",
        attributes: { title: "Hello" },
      },
      included: [
        {
          type: "articles",
          id: "1",
          attributes: { body: "World" },
          relationships: {
            author: { data: { type: "people", id: "9" } },
          },
        },
        {
          type: "people",
          id: "9",
          attributes: { name: "Ada" },
        },
      ],
    });

    const article = result.resources.get("articles", "1");
    assert.ok(article);
    assert.deepEqual(article.attributes, { title: "Hello", body: "World" });
    assert.deepEqual(article.relationships?.author.data, {
      type: "people",
      id: "9",
    });
    assert.deepEqual(
      result.resources.map((resource) => getResourceKey(resource)),
      ["articles:1", "people:9"],
    );
  });

  it("rejects the whole round on a field conflict", () => {
    assert.throws(
      () =>
        mergeJsonApiDocuments({
          data: { type: "articles", id: "1", attributes: { title: "A" } },
          included: [
            { type: "articles", id: "1", attributes: { title: "B" } },
          ],
        }),
      (error) => {
        assert.ok(error instanceof JsonApiMergeConflictError);
        assert.equal(error.conflicts.length, 1);
        assert.equal(error.conflicts[0]?.path, "articles:1.attributes.title");
        return true;
      },
    );
  });

  it("rejects conflicting relationship linkage and null-vs-empty", () => {
    assert.throws(
      () =>
        mergeJsonApiDocuments({
          data: {
            type: "articles",
            id: "1",
            relationships: { author: { data: { type: "people", id: "1" } } },
          },
          included: [
            {
              type: "articles",
              id: "1",
              relationships: { author: { data: { type: "people", id: "2" } } },
            },
          ],
        }),
      JsonApiMergeConflictError,
    );

    assert.throws(
      () =>
        mergeJsonApiDocuments({
          data: {
            type: "articles",
            id: "1",
            relationships: { author: { data: null } },
          },
          included: [
            {
              type: "articles",
              id: "1",
              relationships: { author: { data: [] } },
            },
          ],
        }),
      JsonApiMergeConflictError,
    );
  });

  it("distinguishes unknown relationships from empty linkage", () => {
    const result = mergeJsonApiDocuments({
      data: {
        type: "articles",
        id: "1",
        relationships: {
          author: {},
          comments: { data: [] },
          editor: { data: null },
        },
      },
    });

    const article = result.resources.get("articles", "1");
    assert.ok(article);
    assert.equal(article.relationships?.author.linkageKnown, false);
    assert.equal("data" in (article.relationships?.author ?? {}), false);
    assert.equal(article.relationships?.comments.linkageKnown, true);
    assert.deepEqual(article.relationships?.comments.data, []);
    assert.equal(article.relationships?.editor.linkageKnown, true);
    assert.equal(article.relationships?.editor.data, null);
    assert.deepEqual(result.missing, []);
  });

  it("keeps a known relationship when another representation omits it", () => {
    const result = mergeJsonApiDocuments({
      data: {
        type: "articles",
        id: "1",
        relationships: { author: { data: { type: "people", id: "9" } } },
      },
      included: [
        {
          type: "articles",
          id: "1",
          attributes: { title: "Hello" },
        },
        { type: "people", id: "9", attributes: { name: "Ada" } },
      ],
    });

    const article = result.resources.get("articles", "1");
    assert.equal(article?.relationships?.author.linkageKnown, true);
    assert.deepEqual(article?.relationships?.author.data, {
      type: "people",
      id: "9",
    });
  });

  it("collects missing linkage and excludes unreachable included resources", () => {
    const result = mergeJsonApiDocuments({
      data: [
        {
          type: "articles",
          id: "1",
          relationships: {
            author: { data: { type: "people", id: "missing" } },
            comments: {
              data: [
                { type: "comments", id: "2" },
                { type: "comments", id: "absent" },
              ],
            },
          },
        },
      ],
      included: [
        {
          type: "comments",
          id: "2",
          relationships: {
            author: { data: { type: "people", id: "missing" } },
          },
        },
        { type: "people", id: "unreachable", attributes: { name: "Nobody" } },
      ],
    });

    assert.deepEqual(
      result.resources.map((resource) => getResourceKey(resource)),
      ["articles:1", "comments:2"],
    );
    assert.deepEqual(
      result.missing.map((resource) => getResourceKey(resource)),
      ["people:missing", "comments:absent"],
    );
    assert.equal(result.missing[0]?.source?.type, "articles");
    assert.equal(result.missing[0]?.relationship, "author");
    assert.equal(result.all.get("people", "unreachable")?.attributes?.name, "Nobody");
    assert.equal(result.resources.get("people", "unreachable"), undefined);
  });

  it("handles relationship cycles", () => {
    const result = mergeJsonApiDocuments({
      data: { type: "nodes", id: "a", relationships: { next: { data: { type: "nodes", id: "b" } } } },
      included: [
        { type: "nodes", id: "b", relationships: { next: { data: { type: "nodes", id: "a" } } } },
      ],
    });

    assert.deepEqual(
      result.resources.map((resource) => resource.id),
      ["a", "b"],
    );
    assert.deepEqual(result.missing, []);
  });

  it("merges multiple documents in one round", () => {
    const result = mergeJsonApiDocuments(
      {
        data: { type: "articles", id: "1", attributes: { title: "Hello" } },
      },
      {
        data: { type: "articles", id: "1", attributes: { body: "World" } },
      },
    );

    assert.deepEqual(result.resources[0]?.attributes, {
      title: "Hello",
      body: "World",
    });
  });

  it("merges resource arrays directly", () => {
    const result = mergeResources([
      { type: "people", id: "1", attributes: { name: "Ada" } },
      { type: "people", id: "1", attributes: { email: "ada@example.com" } },
    ]);

    assert.deepEqual(result.resources[0]?.attributes, {
      name: "Ada",
      email: "ada@example.com",
    });
  });

  it("reports conflicts without throwing when configured", () => {
    const result = mergeJsonApiDocuments(
      {
        data: { type: "articles", id: "1", attributes: { title: "A" } },
        included: [{ type: "articles", id: "1", attributes: { title: "B" } }],
      },
      { rejectConflicts: false },
    );

    assert.equal(result.conflicts.length, 1);
    assert.equal(result.resources[0]?.attributes?.title, "A");
  });

  it("unions to-many linkage in union mode", () => {
    const result = mergeJsonApiDocuments(
      {
        data: {
          type: "articles",
          id: "1",
          relationships: { tags: { data: [{ type: "tags", id: "a" }] } },
        },
        included: [
          {
            type: "articles",
            id: "1",
            relationships: { tags: { data: [{ type: "tags", id: "b" }] } },
          },
          { type: "tags", id: "a" },
          { type: "tags", id: "b" },
        ],
      },
      { linkageMerge: "union" },
    );

    assert.deepEqual(result.resources[0]?.relationships?.tags.data, [
      { type: "tags", id: "a" },
      { type: "tags", id: "b" },
    ]);
    assert.equal(result.resources.length, 3);
  });

  it("accepts JSON text and validates identity", () => {
    const document = parseJsonApiDocument(
      JSON.stringify({ data: { type: "articles", id: "1" } }),
    );
    assert.equal(
      document.data && !Array.isArray(document.data) ? document.data.id : undefined,
      "1",
    );
    assert.throws(
      () => mergeJsonApiDocuments({ data: { type: "articles", id: 1 } }),
      JsonApiParseError,
    );
  });

  it("returns a discriminated result from the safe entry point", () => {
    const failed = tryMergeJsonApiDocuments({
      data: { type: "articles", id: "1", attributes: { title: "A" } },
      included: [{ type: "articles", id: "1", attributes: { title: "B" } }],
    });
    assert.equal(failed.ok, false);

    const succeeded = tryMergeJsonApiDocuments({
      data: { type: "articles", id: "1" },
    });
    assert.equal(succeeded.ok, true);
  });

  it("supports explicit roots and all-root mode", () => {
    const document = {
      data: { type: "articles", id: "1", relationships: { author: { data: { type: "people", id: "9" } } } },
      included: [{ type: "people", id: "9" }],
    };
    assert.equal(buildResourceClosure(document).resources.length, 2);
    assert.equal(
      mergeJsonApiDocuments(document, { roots: [] }).resources.length,
      0,
    );
    assert.equal(
      mergeJsonApiDocuments(document, { rootMode: "all" }).resources.length,
      2,
    );
  });

  it("does not mutate its input", () => {
    const document = {
      data: {
        type: "articles",
        id: "1",
        attributes: { tags: ["a"] },
      },
    };
    const snapshot = structuredClone(document);
    const result = mergeJsonApiDocuments(document);
    result.resources[0].attributes.tags[0] = "changed";
    result.resources[0].attributes.title = "new";
    assert.deepEqual(document, snapshot);
  });
});
