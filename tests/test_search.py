import unittest

from logfilter import (
    CursorError,
    Index,
    parse_pattern,
    search,
    validate_alignment,
)


def make_index():
    index = Index()
    index.add_document("d1", ["cat", "cut"])
    index.add_document("d2", ["cat"])
    index.add_document("d3", ["cats", "scat", "dog"])
    index.add_document("d4", ["ca", "at", "ct", "cog"])
    return index


def doc_ids(result):
    return [entry["doc_id"] for entry in result.results]


def terms_of(result, doc_id):
    for entry in result.results:
        if entry["doc_id"] == doc_id:
            return [t["term"] for t in entry["terms"]]
    return None


class TestWildcardSemantics(unittest.TestCase):
    def setUp(self):
        self.index = Index()
        self.index.add_document("d1", ["ab", "abc", "abbc", "ac", "axc", "ax"])

    def find_terms(self, pattern, d=None):
        result = search(self.index, pattern=pattern, d=d, limit=100)
        self.assertTrue(result.complete)
        found = set()
        for entry in result.results:
            for hit in entry["terms"]:
                found.add(hit["term"])
        return found

    def test_star_matches_empty_string(self):
        self.assertEqual(self.find_terms("ab*"), {"ab", "abc", "abbc"})
        self.assertEqual(self.find_terms("ab*c"), {"abc", "abbc"})

    def test_star_matches_everything(self):
        self.assertEqual(
            self.find_terms("*"), {"ab", "abc", "abbc", "ac", "axc", "ax"}
        )

    def test_question_mark_is_exactly_one_char(self):
        self.assertEqual(self.find_terms("a?c"), {"abc", "axc"})
        self.assertEqual(self.find_terms("a?"), {"ab", "ac", "ax"})
        self.assertEqual(self.find_terms("a??"), {"abc", "axc"})

    def test_char_class_endpoints(self):
        index = Index()
        index.add_document("d1", ["ax", "bx", "cx", "dx"])
        result = search(index, pattern="[a-c]x", limit=100)
        got = {t["term"] for e in result.results for t in e["terms"]}
        self.assertEqual(got, {"ax", "bx", "cx"})
        result = search(index, pattern="[^a-c]x", limit=100)
        got = {t["term"] for e in result.results for t in e["terms"]}
        self.assertEqual(got, {"dx"})


class TestEditDistance(unittest.TestCase):
    def setUp(self):
        self.index = make_index()

    def find(self, pattern, d=None):
        result = search(self.index, pattern=pattern, d=d, limit=100)
        self.assertTrue(result.complete)
        out = {}
        for entry in result.results:
            for hit in entry["terms"]:
                out[hit["term"]] = hit["distance"]
        return out

    def test_distance_zero_is_exact(self):
        self.assertEqual(self.find("cat"), {"cat": 0})

    def test_distance_one(self):
        got = self.find("cat{~1}")
        self.assertEqual(
            got,
            {"cat": 0, "cut": 1, "cats": 1, "scat": 1, "ca": 1, "at": 1, "ct": 1},
        )

    def test_distance_two(self):
        got = self.find("cat{~2}")
        self.assertEqual(got["cog"], 2)
        self.assertNotIn("dog", got)  # distance 3, still excluded

    def test_marker_and_argument(self):
        self.assertEqual(self.find("cat", d=1), self.find("cat{~1}"))

    def test_hits_carry_valid_alignment_evidence(self):
        result = search(self.index, pattern="cat{~2}", limit=100)
        elements = parse_pattern("cat{~2}").elements
        self.assertTrue(result.results)
        for entry in result.results:
            for hit in entry["terms"]:
                ok, cost = validate_alignment(elements, hit["term"], hit["alignment"])
                self.assertTrue(ok, hit)
                self.assertEqual(cost, hit["distance"], hit)
                self.assertLessEqual(hit["distance"], 2)


class TestDocumentDedup(unittest.TestCase):
    def test_same_word_in_different_documents(self):
        index = make_index()
        result = search(index, pattern="cat", limit=100)
        self.assertEqual(sorted(doc_ids(result)), ["d1", "d2"])
        self.assertEqual(doc_ids(result).count("d1"), 1)
        self.assertEqual(doc_ids(result).count("d2"), 1)

    def test_multiple_matching_terms_single_document_entry(self):
        index = make_index()
        result = search(index, pattern="c?t", limit=100)
        self.assertEqual(doc_ids(result).count("d1"), 1)
        self.assertEqual(sorted(terms_of(result, "d1")), ["cat", "cut"])

    def test_deleted_document_disappears_from_results(self):
        index = make_index()
        index.delete_document("d2")
        result = search(index, pattern="cat", limit=100)
        self.assertEqual(doc_ids(result), ["d1"])


class TestPaginationBudgetResume(unittest.TestCase):
    def setUp(self):
        self.index = Index()
        for i in range(10):
            self.index.add_document(f"doc{i:02d}", [f"term{i}", "common"])

    def collect_all(self, limit, budget=None):
        docs = []
        cursor = None
        pages = 0
        while True:
            result = search(
                self.index,
                pattern="t*" if cursor is None else None,
                limit=limit,
                budget=budget,
                cursor=cursor,
            )
            docs.extend(doc_ids(result))
            pages += 1
            self.assertLess(pages, 100, "pagination did not terminate")
            if result.complete:
                self.assertIsNone(result.cursor)
                return docs
            self.assertIsNotNone(result.cursor, "incomplete result without cursor")
            cursor = result.cursor

    def test_full_scan_baseline(self):
        result = search(self.index, pattern="t*", limit=100)
        self.assertTrue(result.complete)
        self.assertEqual(len(result.results), 10)

    def test_pagination_resume_matches_full_scan(self):
        full = doc_ids(search(self.index, pattern="t*", limit=100))
        for limit in (1, 3, 7):
            with self.subTest(limit=limit):
                self.assertEqual(self.collect_all(limit), full)
                self.assertEqual(len(set(self.collect_all(limit))), 10)

    def test_budget_interrupts_and_resume_completes(self):
        first = search(self.index, pattern="t*", limit=100, budget=1)
        self.assertFalse(first.complete)
        self.assertIsNotNone(first.cursor)
        self.assertEqual(first.stats["expansions"], 1)
        # frontier keeps a distance lower bound for every unexplored entry
        self.assertTrue(first.frontier)
        for entry in first.frontier:
            self.assertIn("distance_lower_bound", entry)
            self.assertGreaterEqual(entry["distance_lower_bound"], 0)

        rest = search(self.index, cursor=first.cursor, limit=100)
        self.assertTrue(rest.complete)
        combined = doc_ids(first) + doc_ids(rest)
        self.assertEqual(combined, doc_ids(search(self.index, pattern="t*", limit=100)))

    def test_tight_budget_never_marks_incomplete_as_complete(self):
        cursor = None
        saw_incomplete = False
        for _ in range(500):
            result = search(
                self.index,
                pattern="t*{~1}" if cursor is None else None,
                limit=2,
                budget=3,
                cursor=cursor,
            )
            if result.complete:
                break
            saw_incomplete = True
            self.assertIsNotNone(result.cursor)
            cursor = result.cursor
        self.assertTrue(saw_incomplete)
        self.assertTrue(result.complete)

    def test_stale_cursor_rejected_after_mutation(self):
        first = search(self.index, pattern="t*", limit=2)
        self.assertIsNotNone(first.cursor)
        self.index.add_document("docX", ["termX"])
        with self.assertRaises(CursorError):
            search(self.index, cursor=first.cursor)

    def test_cursor_pattern_mismatch_rejected(self):
        first = search(self.index, pattern="t*", limit=2)
        with self.assertRaises(CursorError):
            search(self.index, pattern="c*", cursor=first.cursor)

    def test_cursor_survives_json_roundtrip(self):
        import json

        first = search(self.index, pattern="t*", limit=4)
        cursor = json.loads(json.dumps(first.cursor))
        rest = search(self.index, cursor=cursor, limit=100)
        self.assertTrue(rest.complete)
        combined = doc_ids(first) + doc_ids(rest)
        self.assertEqual(combined, doc_ids(search(self.index, pattern="t*", limit=100)))


if __name__ == "__main__":
    unittest.main()
