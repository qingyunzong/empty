import unittest

from logfilter import CursorError, Index, parse_pattern, search


def make_index():
    idx = Index()
    idx.add_document("d1", "error warning info debug trace")
    idx.add_document("d2", "error errror eror warn fatal")
    idx.add_document("d3", "error errormsg msg error")
    return idx


def words(result):
    return {hit["word"]: hit for hit in result["results"]}


class TestBasicMatching(unittest.TestCase):
    def setUp(self):
        self.idx = make_index()

    def test_exact(self):
        hits = words(search(self.idx, parse_pattern("error")))
        self.assertEqual(sorted(hits), ["error"])
        self.assertEqual(hits["error"]["edits"], 0)
        self.assertEqual(hits["error"]["docs"], ["d1", "d2", "d3"])

    def test_star_matches_empty_string(self):
        hits = words(search(self.idx, parse_pattern("error*")))
        self.assertIn("error", hits)  # star consumed nothing
        self.assertIn("errormsg", hits)
        self.assertEqual(hits["error"]["edits"], 0)

    def test_star_matches_many(self):
        hits = words(search(self.idx, parse_pattern("err*")))
        self.assertEqual(sorted(hits), ["error", "errormsg", "errror"])

    def test_star_only_matches_everything(self):
        hits = words(search(self.idx, parse_pattern("*")))
        self.assertEqual(sorted(hits), sorted(self.idx.postings))

    def test_question_mark(self):
        hits = words(search(self.idx, parse_pattern("erro?")))
        self.assertEqual(sorted(hits), ["error"])

    def test_character_class(self):
        hits = words(search(self.idx, parse_pattern("[ei]rror")))
        self.assertEqual(sorted(hits), ["error"])
        hits = words(search(self.idx, parse_pattern("[!e]rror")))
        self.assertEqual(sorted(hits), [])

    def test_edit_distance_one(self):
        hits = words(search(self.idx, parse_pattern("error~1")))
        self.assertEqual(sorted(hits), ["eror", "error", "errror"])
        self.assertEqual(hits["eror"]["edits"], 1)    # word char dropped
        self.assertEqual(hits["errror"]["edits"], 1)  # extra word char

    def test_edit_distance_two(self):
        hits = words(search(self.idx, parse_pattern("error~2")))
        self.assertIn("eror", hits)
        self.assertIn("errror", hits)
        self.assertNotIn("warn", hits)  # distance > 2

    def test_edits_combined_with_wildcards(self):
        hits = words(search(self.idx, parse_pattern("err?r~1")))
        self.assertIn("error", hits)
        self.assertIn("errror", hits)
        self.assertIn("eror", hits)

    def test_no_match_returns_empty_and_complete(self):
        result = search(self.idx, parse_pattern("zzzzz~2"))
        self.assertEqual(result["results"], [])
        self.assertTrue(result["complete"])
        self.assertIsNone(result["cursor"])


class TestAlignmentEvidence(unittest.TestCase):
    def setUp(self):
        self.idx = make_index()

    def test_hit_carries_alignment(self):
        hits = words(search(self.idx, parse_pattern("error~1")))
        align = hits["eror"]["alignment"]
        self.assertEqual(align["edits"], 1)
        ops = align["ops"]
        self.assertEqual(sum(1 for op in ops if op["op"] in
                             ("substitute", "delete", "insert")), 1)
        self.assertIn({"op": "insert", "pattern": "r"}, ops)

    def test_substitute_alignment(self):
        idx = Index()
        idx.add_document("d1", "cut")
        hits = words(search(idx, parse_pattern("cat~1")))
        ops = hits["cut"]["alignment"]["ops"]
        self.assertIn({"op": "substitute", "pattern": "a", "word": "u"}, ops)

    def test_insert_alignment(self):
        idx = Index()
        idx.add_document("d1", "abc")
        hits = words(search(idx, parse_pattern("ac~1")))
        ops = hits["abc"]["alignment"]["ops"]
        self.assertIn({"op": "delete", "word": "b"}, ops)

    def test_star_alignment(self):
        idx = Index()
        idx.add_document("d1", "abbc")
        hits = words(search(idx, parse_pattern("a*c")))
        ops = hits["abbc"]["alignment"]["ops"]
        star_chars = [op["word"] for op in ops if op["op"] == "star"]
        self.assertEqual(star_chars, ["b", "b"])
        self.assertEqual(hits["abbc"]["alignment"]["edits"], 0)

    def test_alignment_cost_matches_engine_cost(self):
        for pat in ("error~1", "err*~1", "[ei]rro?~2", "*~0"):
            for hit in search(self.idx, parse_pattern(pat))["results"]:
                self.assertEqual(hit["alignment"]["edits"], hit["edits"],
                                 msg=(pat, hit["word"]))


class TestPaginationBudgetResume(unittest.TestCase):
    def setUp(self):
        self.idx = Index()
        # 60 distinct words across several documents
        for doc in range(6):
            text = " ".join(f"w{doc}{i:02d}x" for i in range(10))
            self.idx.add_document(f"doc{doc}", text)

    def full(self):
        result = search(self.idx, parse_pattern("*"))
        self.assertTrue(result["complete"])
        return [h["word"] for h in result["results"]]

    def test_pagination_resume(self):
        pattern = parse_pattern("*")
        seen = []
        cursor = None
        pages = 0
        while True:
            result = search(self.idx, pattern, limit=7, cursor=cursor)
            seen.extend(h["word"] for h in result["results"])
            pages += 1
            if result["complete"]:
                self.assertIsNone(result["cursor"])
                break
            self.assertIsNotNone(result["cursor"])
            cursor = result["cursor"]
            self.assertLess(pages, 100)
        self.assertEqual(len(seen), len(set(seen)))  # no duplicates across pages
        self.assertEqual(sorted(seen), self.full())

    def test_budget_resume(self):
        pattern = parse_pattern("w00*x~1")
        cursor = None
        seen = []
        for _ in range(500):
            result = search(self.idx, pattern, budget=5, cursor=cursor)
            seen.extend(h["word"] for h in result["results"])
            if result["complete"]:
                break
            cursor = result["cursor"]
        else:
            self.fail("did not converge")
        full = search(self.idx, pattern)
        self.assertEqual(sorted(seen), [h["word"] for h in full["results"]])

    def test_incomplete_result_not_marked_complete(self):
        result = search(self.idx, parse_pattern("*"), limit=5)
        self.assertFalse(result["complete"])
        self.assertIsNotNone(result["cursor"])
        self.assertEqual(len(result["results"]), 5)
        result = search(self.idx, parse_pattern("*"), budget=1)
        self.assertFalse(result["complete"])

    def test_frontier_keeps_distance_lower_bound(self):
        result = search(self.idx, parse_pattern("w000x~2"), budget=1)
        self.assertFalse(result["complete"])
        lower = result["stats"]["frontier_lower_bound"]
        self.assertIsNotNone(lower)
        self.assertGreaterEqual(lower, 0)
        self.assertLessEqual(lower, 2)
        # every undiscovered hit must cost at least the bound
        full = words(search(self.idx, parse_pattern("w000x~2")))
        found = {h["word"] for h in result["results"]}
        for word, hit in full.items():
            if word not in found:
                self.assertGreaterEqual(hit["edits"], lower)

    def test_cursor_rejects_mismatched_pattern(self):
        pattern = parse_pattern("*")
        result = search(self.idx, pattern, limit=3)
        with self.assertRaises(CursorError):
            search(self.idx, parse_pattern("w*"), limit=3, cursor=result["cursor"])

    def test_cursor_serializable(self):
        import json
        result = search(self.idx, parse_pattern("*"), limit=3)
        cursor = json.loads(json.dumps(result["cursor"]))
        page2 = search(self.idx, parse_pattern("*"), limit=3, cursor=cursor)
        self.assertEqual(len(page2["results"]), 3)


class TestExactnessAfterMutation(unittest.TestCase):
    def test_results_track_incremental_updates(self):
        idx = Index()
        idx.add_document("d1", "error errror")
        idx.add_document("d2", "error")
        pattern = parse_pattern("error~1")
        hits = words(search(idx, pattern))
        self.assertEqual(hits["errror"]["docs"], ["d1"])
        self.assertEqual(hits["error"]["docs"], ["d1", "d2"])
        idx.delete_document("d1")
        hits = words(search(idx, pattern))
        self.assertNotIn("errror", hits)  # last reference removed
        self.assertEqual(hits["error"]["docs"], ["d2"])
        idx.add_document("d3", "eror")
        hits = words(search(idx, pattern))
        self.assertEqual(hits["eror"]["docs"], ["d3"])


if __name__ == "__main__":
    unittest.main()
