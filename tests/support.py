"""Shared fixtures: a small library exercising every edge case."""

DOCS = {
    # same-name array fields + multiple fragments in one document
    "d1": {
        "title": "the quick brown fox",
        "body": "jumps over\nthe lazy dog",
        "tags": ["quick brown", "brown fox"],
    },
    # cross-field pseudo phrase: "quick" and "brown" live in different fields
    "d2": {"title": "quick", "body": "brown", "tags": ["quick", "brown"]},
    # empty field value + deeply nested field
    "d3": {"title": "", "meta": {"author": {"name": "ada lovelace"}}},
    # no title at all; nested field used by move tests
    "d4": {"tags": ["foo", "bar baz"], "nested": {"a": {"b": "deep value here"}}},
    # paragraph boundary inside one field
    "d5": {"title": "lazy dog", "body": "the dog is lazy\n\nnew paragraph dog"},
    # empty array field
    "d6": {"title": "fox", "tags": []},
}

QUERIES = [
    "title:quick",
    '"quick brown"',
    'tags[*]:"quick brown"',
    "NOT title:*",
    "lazy NEAR/2 dog",
    "(title:fox OR title:dog) AND NOT tags[*]:quick",
    "meta.author.name:ada",
    'nested.a.b:"deep value"',
    "*",
    '"dog new"',
    'body:"over the"',
    "title:lazy AND body:dog",
    "NOT title:fox",
    "tags[1]:fox",
    "title:fox OR body:dog",
    "lazy NEAR dog",
    "body:dog NEAR/1 body:lazy",
    "NOT NOT title:fox",
    "title:*",
    "tags[*]:*",
]


def build_index():
    from docindex import Index

    index = Index()
    for doc_id, doc in DOCS.items():
        index.add_doc(doc_id, doc)
    return index
