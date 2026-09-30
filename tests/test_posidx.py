"""Acceptance tests for posidx.

A: 200 random documents, AND/OR/NOT/phrase queries cross-checked against a
   naive full scan.
B: re-ingesting the same id fully replaces the old version.
C: delete + save/load keeps query results identical to the in-memory index.
D: CLI exit codes for bad JSONL lines (2), bad/empty queries (3), corrupt
   manifest (4), and empty results (0 with ``[]``).
"""

from __future__ import annotations

import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from posidx import (  # noqa: E402
    PositionalIndex,
    QuerySyntaxError,
    evaluate,
    parse_query,
    search,
    tokenize,
)


def naive_eval(node, docs: dict[str, list[str]]) -> set[str]:
    """Reference evaluator: plain scan over tokenized documents."""
    kind = node[0]
    if kind == "term":
        term = node[1]
        return {d for d, toks in docs.items() if term in toks}
    if kind == "phrase":
        terms = node[1]
        n = len(terms)
        hits = set()
        for d, toks in docs.items():
            if any(toks[i : i + n] == terms for i in range(len(toks) - n + 1)):
                hits.add(d)
        return hits
    if kind == "and":
        return naive_eval(node[1], docs) & naive_eval(node[2], docs)
    if kind == "or":
        return naive_eval(node[1], docs) | naive_eval(node[2], docs)
    if kind == "not":
        return set(docs) - naive_eval(node[1], docs)
    raise AssertionError(f"bad node {node!r}")


class TokenizeTest(unittest.TestCase):
    def test_unicode_lowercase_alnum_runs(self):
        self.assertEqual(tokenize("Hello, WORLD!"), ["hello", "world"])
        self.assertEqual(tokenize("café 123 _x y_z"), ["café", "123", "x", "y", "z"])
        self.assertEqual(tokenize("Äpfel Ωμέγα 中文"), ["äpfel", "ωμέγα", "中文"])
        self.assertEqual(tokenize(""), [])
        self.assertEqual(tokenize("--- !!!"), [])

    def test_positions_count_tokens_only(self):
        idx = PositionalIndex()
        idx.ingest("d", "a, b... c")
        self.assertEqual(idx.postings("a")["d"], [0])
        self.assertEqual(idx.postings("b")["d"], [1])
        self.assertEqual(idx.postings("c")["d"], [2])


class AcceptanceA(unittest.TestCase):
    """Random 200-document corpus, index vs naive scan."""

    def test_random_corpus_matches_naive_scan(self):
        rng = random.Random(20260930)
        vocab = [f"w{i}" for i in range(40)] + ["café", "naïve", "x1", "2b"]
        docs: dict[str, list[str]] = {}
        idx = PositionalIndex()
        for i in range(200):
            doc_id = f"doc{i}"
            words = [rng.choice(vocab) for _ in range(rng.randint(3, 30))]
            text = " ".join(words)
            docs[doc_id] = tokenize(text)
            idx.ingest(doc_id, text)

        def rand_query(depth: int) -> str:
            if depth <= 0:
                r = rng.random()
                if r < 0.45:
                    return rng.choice(vocab)
                if r < 0.75:  # phrase sampled from a real document
                    toks = rng.choice(list(docs.values()))
                    if len(toks) >= 2:
                        start = rng.randrange(len(toks) - 1)
                        n = rng.choice((2, 2, 3))
                        frag = toks[start : start + n]
                        if len(frag) >= 2:
                            return '"' + " ".join(frag) + '"'
                    return rng.choice(vocab)
                # random (likely absent) phrase
                return '"%s %s"' % (rng.choice(vocab), rng.choice(vocab))
            op = rng.random()
            if op < 0.35:
                return f"({rand_query(depth - 1)}) AND ({rand_query(depth - 1)})"
            if op < 0.7:
                return f"({rand_query(depth - 1)}) OR ({rand_query(depth - 1)})"
            return f"NOT ({rand_query(depth - 1)})"

        for _ in range(300):
            q = rand_query(depth=rng.randint(0, 3))
            ast = parse_query(q)
            expected = naive_eval(ast, docs)
            got = evaluate(ast, idx)
            self.assertEqual(
                got, expected, f"query {q!r}: index != naive scan"
            )


class AcceptanceB(unittest.TestCase):
    """Re-ingesting the same id replaces the old version entirely."""

    def test_old_terms_do_not_hit_after_reingest(self):
        idx = PositionalIndex()
        idx.ingest("x", "alpha beta gamma")
        idx.ingest("y", "alpha delta")
        self.assertEqual(search(idx, "alpha"), {"x", "y"})

        idx.ingest("x", "delta epsilon")  # full replacement
        self.assertEqual(search(idx, "alpha"), {"y"})
        self.assertEqual(search(idx, "beta"), set())
        self.assertEqual(search(idx, "gamma"), set())
        self.assertEqual(search(idx, "delta"), {"x", "y"})
        self.assertEqual(search(idx, '"delta epsilon"'), {"x"})
        # postings for removed terms must not reference x anymore
        self.assertNotIn("x", idx.postings("alpha"))
        self.assertEqual(idx.postings("beta"), {})

    def test_reingest_identical_text_is_stable(self):
        idx = PositionalIndex()
        idx.ingest("x", "one two one")
        idx.ingest("x", "one two one")
        self.assertEqual(idx.postings("one")["x"], [0, 2])
        self.assertEqual(search(idx, '"one two one"'), {"x"})


class AcceptanceC(unittest.TestCase):
    """Delete + save/load round-trip keeps results identical."""

    def _build(self) -> PositionalIndex:
        idx = PositionalIndex()
        idx.ingest("a", "the quick brown fox jumps")
        idx.ingest("b", "the lazy dog sleeps")
        idx.ingest("c", "quick brown quick brown")
        idx.ingest("d", "unrelated words entirely")
        return idx

    def test_delete_is_noop_for_missing_id(self):
        idx = self._build()
        self.assertFalse(idx.delete("nope"))
        self.assertEqual(len(idx), 4)

    def test_deleted_docs_never_match(self):
        idx = self._build()
        idx.delete("a")
        idx.delete("c")
        self.assertEqual(search(idx, "quick"), set())
        self.assertEqual(search(idx, "the"), {"b"})
        self.assertEqual(search(idx, "NOT the"), {"d"})
        self.assertEqual(search(idx, '"quick brown"'), set())

    def test_save_load_roundtrip_matches_memory(self):
        idx = self._build()
        idx.ingest("a", "replaced text with quick")  # replace existing id
        idx.delete("d")
        queries = [
            "quick",
            "the AND quick",
            "the OR unrelated",
            "NOT the",
            '"quick brown"',
            "(quick AND NOT lazy) OR dog",
            "missingterm",
        ]
        before = {q: search(idx, q) for q in queries}
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "idx")
            idx.save(path)
            loaded = PositionalIndex.load(path)
        after = {q: search(loaded, q) for q in queries}
        self.assertEqual(before, after)
        self.assertEqual(len(loaded), 3)
        self.assertNotIn("d", loaded.doc_ids())


class AcceptanceD(unittest.TestCase):
    """CLI exit codes and output contract."""

    def run_cli(self, *argv: str) -> subprocess.CompletedProcess:
        env = dict(os.environ)
        env["PYTHONPATH"] = REPO_ROOT + os.pathsep + env.get("PYTHONPATH", "")
        return subprocess.run(
            [sys.executable, "-m", "posidx", *argv],
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
            env=env,
        )

    def test_bad_jsonl_lines_exit_2_and_are_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            jsonl = os.path.join(tmp, "docs.jsonl")
            with open(jsonl, "w", encoding="utf-8") as fh:
                fh.write('{"id": "ok", "text": "hello world"}\n')
                fh.write("this is not json\n")
                fh.write('{"id": 5, "text": "bad id type"}\n')
                fh.write('{"id": "ok2", "text": "second doc"}\n')
            idx_dir = os.path.join(tmp, "idx")
            res = self.run_cli("ingest", idx_dir, jsonl)
            self.assertEqual(res.returncode, 2, res.stderr)
            # good lines were still ingested
            res = self.run_cli("query", idx_dir, "hello")
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(json.loads(res.stdout), ["ok"])
            res = self.run_cli("query", idx_dir, "second")
            self.assertEqual(json.loads(res.stdout), ["ok2"])

    def test_empty_and_broken_queries_exit_3(self):
        with tempfile.TemporaryDirectory() as tmp:
            idx_dir = os.path.join(tmp, "idx")
            jsonl = os.path.join(tmp, "docs.jsonl")
            with open(jsonl, "w", encoding="utf-8") as fh:
                fh.write('{"id": "a", "text": "hello"}\n')
            self.assertEqual(self.run_cli("ingest", idx_dir, jsonl).returncode, 0)
            for bad in ["", "   ", "AND hello", "hello AND", "NOT", "(hello",
                        "hello)", '"unterminated', 'hello OR']:
                res = self.run_cli("query", idx_dir, bad)
                self.assertEqual(res.returncode, 3, f"query {bad!r}: {res}")

    def test_corrupt_manifest_exits_4(self):
        with tempfile.TemporaryDirectory() as tmp:
            idx_dir = os.path.join(tmp, "idx")
            os.makedirs(idx_dir)
            with open(os.path.join(idx_dir, "manifest.json"), "w") as fh:
                fh.write("{ not valid json !!!")
            res = self.run_cli("query", idx_dir, "hello")
            self.assertEqual(res.returncode, 4, res.stderr)
            res = self.run_cli("delete", idx_dir, "x")
            self.assertEqual(res.returncode, 4, res.stderr)
            # wrong format/version also corrupt
            with open(os.path.join(idx_dir, "manifest.json"), "w") as fh:
                json.dump({"format": "other", "version": 99}, fh)
            res = self.run_cli("query", idx_dir, "hello")
            self.assertEqual(res.returncode, 4, res.stderr)
            # manifest fine but docs.json missing -> corrupt
            with open(os.path.join(idx_dir, "manifest.json"), "w") as fh:
                json.dump({"format": "posidx", "version": 1, "doc_count": 0}, fh)
            res = self.run_cli("query", idx_dir, "hello")
            self.assertEqual(res.returncode, 4, res.stderr)

    def test_no_results_exit_0_empty_array(self):
        with tempfile.TemporaryDirectory() as tmp:
            idx_dir = os.path.join(tmp, "idx")
            jsonl = os.path.join(tmp, "docs.jsonl")
            with open(jsonl, "w", encoding="utf-8") as fh:
                fh.write('{"id": "a", "text": "hello world"}\n')
            self.assertEqual(self.run_cli("ingest", idx_dir, jsonl).returncode, 0)
            res = self.run_cli("query", idx_dir, "absentterm")
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(json.loads(res.stdout), [])
            self.assertEqual(res.stdout.strip(), "[]")

    def test_delete_nonexistent_id_is_noop_exit_0(self):
        with tempfile.TemporaryDirectory() as tmp:
            idx_dir = os.path.join(tmp, "idx")
            jsonl = os.path.join(tmp, "docs.jsonl")
            with open(jsonl, "w", encoding="utf-8") as fh:
                fh.write('{"id": "a", "text": "hello"}\n')
            self.assertEqual(self.run_cli("ingest", idx_dir, jsonl).returncode, 0)
            res = self.run_cli("delete", idx_dir, "ghost")
            self.assertEqual(res.returncode, 0, res.stderr)
            res = self.run_cli("query", idx_dir, "hello")
            self.assertEqual(json.loads(res.stdout), ["a"])


class QuerySyntaxTest(unittest.TestCase):
    def test_precedence_not_and_or(self):
        idx = PositionalIndex()
        idx.ingest("1", "a")
        idx.ingest("2", "b")
        idx.ingest("3", "a b")
        idx.ingest("4", "c")
        # NOT binds tighter than AND, AND tighter than OR
        self.assertEqual(search(idx, "NOT a AND b"), {"2"})
        self.assertEqual(search(idx, "a OR b AND NOT c"), {"1", "2", "3"})
        self.assertEqual(search(idx, "(a OR b) AND NOT c"), {"1", "2", "3"})
        self.assertEqual(search(idx, "NOT (a OR b)"), {"4"})

    def test_phrase_requires_consecutive_positions(self):
        idx = PositionalIndex()
        idx.ingest("1", "new york city")
        idx.ingest("2", "new haven york")
        idx.ingest("3", "york new")
        self.assertEqual(search(idx, '"new york"'), {"1"})
        self.assertEqual(search(idx, '"new york city"'), {"1"})
        self.assertEqual(search(idx, '"york new"'), {"3"})
        self.assertEqual(search(idx, '"city new"'), set())

    def test_operators_are_case_insensitive(self):
        idx = PositionalIndex()
        idx.ingest("1", "a b")
        self.assertEqual(search(idx, "a and b"), {"1"})
        self.assertEqual(search(idx, "a AnD b"), {"1"})


if __name__ == "__main__":
    unittest.main()
