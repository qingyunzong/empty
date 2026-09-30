"""Acceptance tests for posidx (stdlib unittest only)."""

from __future__ import annotations

import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import unittest

from posidx import PositionalIndex, QuerySyntaxError, parse_query, tokenize
from posidx import core

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

WORD_POOL = [
    "apple", "banana", "cherry", "delta", "echo", "foxtrot", "grape",
    "hotel", "india", "jungle", "kilo", "lemon", "mango", "night",
    "orange", "panda", "quest", "river", "stone", "tango",
]


def make_corpus(seed: int = 42, n_docs: int = 200) -> dict[str, str]:
    rng = random.Random(seed)
    corpus = {}
    for i in range(n_docs):
        length = rng.randint(3, 25)
        words = [rng.choice(WORD_POOL) for _ in range(length)]
        # sprinkle punctuation / case to exercise the tokenizer
        text = " ".join(words)
        if rng.random() < 0.3:
            text = text.upper()
        if rng.random() < 0.3:
            text = text.replace(" ", ", ", 1)
        corpus[f"doc{i}"] = text
    return corpus


def naive_eval(node, tokens_by_doc: dict[str, list[str]]) -> set[str]:
    universe = set(tokens_by_doc)
    if isinstance(node, core._Term):
        return {d for d, toks in tokens_by_doc.items() if node.term in toks}
    if isinstance(node, core._Phrase):
        out = set()
        for d, toks in tokens_by_doc.items():
            n = len(node.terms)
            for start in range(len(toks) - n + 1):
                if toks[start:start + n] == node.terms:
                    out.add(d)
                    break
        return out
    if isinstance(node, core._And):
        result = universe
        for child in node.children:
            result &= naive_eval(child, tokens_by_doc)
        return result
    if isinstance(node, core._Or):
        result = set()
        for child in node.children:
            result |= naive_eval(child, tokens_by_doc)
        return result
    if isinstance(node, core._Not):
        return universe - naive_eval(node.child, tokens_by_doc)
    raise AssertionError(f"unknown node {node!r}")


class TestTokenizer(unittest.TestCase):
    def test_lowercase_alnum_runs(self):
        self.assertEqual(tokenize("Hello, WORLD! foo_bar x9"), ["hello", "world", "foo", "bar", "x9"])
        self.assertEqual(tokenize("Ünïcodé 東京123"), ["ünïcodé", "東京123"])
        self.assertEqual(tokenize("   "), [])
        self.assertEqual(tokenize("a-b.c"), ["a", "b", "c"])


class TestA_RandomizedVsNaive(unittest.TestCase):
    """A: 200 random docs, index results must match a naive scan."""

    @classmethod
    def setUpClass(cls):
        cls.corpus = make_corpus()
        cls.tokens = {d: tokenize(t) for d, t in cls.corpus.items()}
        cls.index = PositionalIndex()
        for doc_id, text in cls.corpus.items():
            cls.index.ingest(doc_id, text)

    def check(self, query: str):
        expected = sorted(naive_eval(parse_query(query), self.tokens))
        got = self.index.query(query)
        self.assertEqual(got, expected, f"query {query!r} mismatch")

    def test_single_terms(self):
        for word in WORD_POOL:
            self.check(word)

    def test_and_or_not(self):
        queries = [
            "apple AND banana",
            "apple OR banana",
            "apple AND NOT banana",
            "NOT apple",
            "apple AND banana OR cherry",
            "(apple OR banana) AND NOT cherry",
            "apple AND banana AND cherry AND delta",
            "NOT (apple OR banana)",
            "apple OR banana OR cherry OR delta OR echo",
        ]
        for q in queries:
            self.check(q)

    def test_phrases(self):
        # build phrases that actually occur, plus random ones
        rng = random.Random(7)
        some_doc = self.tokens["doc0"]
        if len(some_doc) >= 3:
            real = " ".join(some_doc[:3])
            self.check(f'"{real}"')
        for _ in range(20):
            n = rng.randint(2, 4)
            phrase = " ".join(rng.choice(WORD_POOL) for _ in range(n))
            self.check(f'"{phrase}"')

    def test_mixed(self):
        self.check('"apple banana" OR (cherry AND NOT delta)')
        self.check('NOT "apple banana cherry"')
        self.check('(apple AND "banana cherry") OR NOT delta')


class TestB_ReingestReplaces(unittest.TestCase):
    """B: re-ingesting the same id must fully replace the old version."""

    def test_old_terms_not_searchable(self):
        idx = PositionalIndex()
        idx.ingest("d1", "alpha beta gamma")
        idx.ingest("d1", "omega psi")
        self.assertEqual(idx.query("alpha"), [])
        self.assertEqual(idx.query("beta OR gamma"), [])
        self.assertEqual(idx.query('"alpha beta"'), [])
        self.assertEqual(idx.query("omega"), ["d1"])
        self.assertEqual(idx.query('"omega psi"'), ["d1"])
        self.assertEqual(idx.query("NOT omega"), [])

    def test_positions_reset_after_replace(self):
        idx = PositionalIndex()
        idx.ingest("d1", "x alpha x beta")
        idx.ingest("d1", "alpha beta")
        self.assertEqual(idx.query('"alpha beta"'), ["d1"])

    def test_postings_do_not_leak(self):
        idx = PositionalIndex()
        idx.ingest("d1", "shared unique_old")
        idx.ingest("d2", "shared")
        idx.ingest("d1", "shared unique_new")
        self.assertEqual(idx.query("unique_old"), [])
        self.assertNotIn("unique_old", idx.postings)
        self.assertEqual(sorted(idx.query("shared")), ["d1", "d2"])


class TestC_DeletePersistReload(unittest.TestCase):
    """C: delete, save/load, then queries must match the in-memory index."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="posidx-test-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_delete_and_reload(self):
        corpus = make_corpus(seed=99, n_docs=60)
        idx = PositionalIndex()
        for doc_id, text in corpus.items():
            idx.ingest(doc_id, text)
        for victim in ["doc0", "doc5", "doc42"]:
            idx.delete(victim)
        idx.delete("doc0")  # deleting twice is a no-op
        idx.delete("never-existed")  # deleting a missing id is a no-op

        directory = os.path.join(self.tmp, "idx")
        idx.save(directory)
        loaded = PositionalIndex.load(directory)

        queries = [
            "apple", "apple AND banana", "apple OR NOT cherry",
            '"apple banana"', "NOT delta", "(apple OR echo) AND NOT stone",
        ]
        for q in queries:
            self.assertEqual(loaded.query(q), idx.query(q), f"query {q!r}")
        for victim in ["doc0", "doc5", "doc42"]:
            for q in queries:
                self.assertNotIn(victim, loaded.query(q))

    def test_deleted_docs_absent_from_all_results(self):
        idx = PositionalIndex()
        idx.ingest("keep", "alpha beta")
        idx.ingest("drop", "alpha beta gamma")
        idx.delete("drop")
        self.assertEqual(idx.query("alpha"), ["keep"])
        self.assertEqual(idx.query("gamma"), [])
        self.assertEqual(idx.query("NOT alpha"), [])
        self.assertEqual(idx.query("NOT gamma"), ["keep"])

    def test_save_load_roundtrip_equality(self):
        idx = PositionalIndex()
        for doc_id, text in make_corpus(seed=7, n_docs=50).items():
            idx.ingest(doc_id, text)
        directory = os.path.join(self.tmp, "rt")
        idx.save(directory)
        loaded = PositionalIndex.load(directory)
        self.assertEqual(idx.docs, loaded.docs)
        self.assertEqual(idx.postings, loaded.postings)


class TestD_CliExitCodes(unittest.TestCase):
    """D: CLI exit codes for bad JSONL, empty query, corrupt manifest."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="posidx-cli-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.index_dir = os.path.join(self.tmp, "idx")

    def run_cli(self, *args: str) -> subprocess.CompletedProcess:
        env = dict(os.environ, PYTHONPATH=REPO_ROOT)
        return subprocess.run(
            [sys.executable, "-m", "posidx", *args],
            capture_output=True, text=True, cwd=REPO_ROOT, env=env,
        )

    def write_jsonl(self, lines: list[str]) -> str:
        path = os.path.join(self.tmp, "data.jsonl")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
        return path

    def test_bad_jsonl_lines_exit_2_and_skip(self):
        path = self.write_jsonl([
            json.dumps({"id": "ok1", "text": "alpha beta"}),
            "this is not json",
            json.dumps({"id": "ok2", "text": "gamma"}),
            json.dumps({"id": 123, "text": "bad id type"}),
            json.dumps({"text": "missing id"}),
        ])
        proc = self.run_cli("ingest", self.index_dir, path)
        self.assertEqual(proc.returncode, 2, proc.stderr)
        # good lines were still ingested
        proc = self.run_cli("query", self.index_dir, "alpha")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout), ["ok1"])
        proc = self.run_cli("query", self.index_dir, "gamma")
        self.assertEqual(json.loads(proc.stdout), ["ok2"])

    def test_clean_ingest_exit_0(self):
        path = self.write_jsonl([json.dumps({"id": "a", "text": "alpha"})])
        proc = self.run_cli("ingest", self.index_dir, path)
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_empty_query_exit_3(self):
        path = self.write_jsonl([json.dumps({"id": "a", "text": "alpha"})])
        self.assertEqual(self.run_cli("ingest", self.index_dir, path).returncode, 0)
        for bad_query in ["", "   ", "AND", "apple AND", "(apple", '"unterminated']:
            proc = self.run_cli("query", self.index_dir, bad_query)
            self.assertEqual(proc.returncode, 3, f"query {bad_query!r}: {proc.stderr}")

    def test_corrupt_manifest_exit_4(self):
        path = self.write_jsonl([json.dumps({"id": "a", "text": "alpha"})])
        self.assertEqual(self.run_cli("ingest", self.index_dir, path).returncode, 0)
        manifest = os.path.join(self.index_dir, "manifest.json")
        with open(manifest, "w", encoding="utf-8") as fh:
            fh.write("{ not valid json !!!")
        for args in [("query", self.index_dir, "alpha"),
                     ("delete", self.index_dir, "a"),
                     ("ingest", self.index_dir, path)]:
            proc = self.run_cli(*args)
            self.assertEqual(proc.returncode, 4, f"{args}: {proc.stderr}")

    def test_tampered_index_exit_4(self):
        path = self.write_jsonl([json.dumps({"id": "a", "text": "alpha"})])
        self.assertEqual(self.run_cli("ingest", self.index_dir, path).returncode, 0)
        index_file = os.path.join(self.index_dir, "index.json")
        with open(index_file, "a", encoding="utf-8") as fh:
            fh.write("tampered")
        proc = self.run_cli("query", self.index_dir, "alpha")
        self.assertEqual(proc.returncode, 4, proc.stderr)

    def test_missing_index_exit_4(self):
        proc = self.run_cli("query", os.path.join(self.tmp, "nope"), "alpha")
        self.assertEqual(proc.returncode, 4, proc.stderr)

    def test_no_results_exit_0_empty_array(self):
        path = self.write_jsonl([json.dumps({"id": "a", "text": "alpha"})])
        self.assertEqual(self.run_cli("ingest", self.index_dir, path).returncode, 0)
        proc = self.run_cli("query", self.index_dir, "zzz_missing")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout), [])

    def test_delete_noop_exit_0(self):
        path = self.write_jsonl([json.dumps({"id": "a", "text": "alpha"})])
        self.assertEqual(self.run_cli("ingest", self.index_dir, path).returncode, 0)
        proc = self.run_cli("delete", self.index_dir, "ghost")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        proc = self.run_cli("query", self.index_dir, "alpha")
        self.assertEqual(json.loads(proc.stdout), ["a"])
        proc = self.run_cli("delete", self.index_dir, "a")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        proc = self.run_cli("query", self.index_dir, "alpha")
        self.assertEqual(json.loads(proc.stdout), [])


class TestQuerySyntax(unittest.TestCase):
    def test_syntax_errors_raise(self):
        for bad in ["", "  ", "AND apple", "apple OR", "(apple", "apple)",
                    '""', "NOT", "apple AND OR banana"]:
                with self.assertRaises(QuerySyntaxError, msg=bad):
                    parse_query(bad)

    def test_valid_queries(self):
        for good in ["apple", "apple AND banana", "NOT apple", '"a b c"',
                     "(a OR b) AND NOT c", "apple banana"]:
            parse_query(good)


if __name__ == "__main__":
    unittest.main()
