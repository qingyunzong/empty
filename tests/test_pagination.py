import unittest
from datetime import date

from billcycle import (BusinessCalendar, CursorMismatch, Rule, expand,
                       get_zone, paginate)
from billcycle.tztable import to_epoch, from_epoch


def utc(y, m, d):
    return to_epoch(from_epoch(0).replace(year=y, month=m, day=d))


START = utc(2024, 1, 1)
END = utc(2026, 1, 1)


def make_rule(**kw):
    defaults = dict(anchor=date(2024, 1, 31), day_of_month=31, adjust="none")
    defaults.update(kw)
    return Rule(**defaults)


class TestForwardPagination(unittest.TestCase):
    def setUp(self):
        self.cal = BusinessCalendar()
        self.zone = get_zone("UTC")
        self.rule = make_rule()

    def _collect(self, rule, reverse=False, page_size=5):
        pages, cursor = [], None
        while True:
            page = paginate(rule, self.cal, self.zone, START, END,
                            page_size=page_size, cursor=cursor,
                            reverse=reverse)
            pages.extend(page.occurrences)
            if not page.has_more:
                return pages, page
            cursor = page.next_cursor
            self.assertIsNotNone(cursor)

    def test_pages_reassemble_full_expansion(self):
        full = expand(self.rule, self.cal, self.zone, START, END).occurrences
        collected, last = self._collect(self.rule, page_size=5)
        self.assertEqual([o.utc for o in collected], [o.utc for o in full])
        self.assertFalse(last.has_more)
        self.assertIsNone(last.next_cursor)

    def test_pages_are_disjoint(self):
        collected, _ = self._collect(self.rule, page_size=4)
        utcs = [o.utc for o in collected]
        self.assertEqual(len(utcs), len(set(utcs)))

    def test_reverse_pagination_descending(self):
        full = expand(self.rule, self.cal, self.zone, START, END).occurrences
        collected, _ = self._collect(self.rule, reverse=True, page_size=4)
        self.assertEqual([o.utc for o in collected],
                         [o.utc for o in reversed(full)])
        utcs = [o.utc for o in collected]
        self.assertEqual(utcs, sorted(utcs, reverse=True))

    def test_cursor_carries_anchor_version_and_exception_hash(self):
        page = paginate(self.rule, self.cal, self.zone, START, END,
                        page_size=3)
        import base64, json
        payload = json.loads(base64.urlsafe_b64decode(page.next_cursor))
        self.assertEqual(payload["anchor"], "2024-01-31")
        self.assertEqual(payload["rule_version"], 1)
        self.assertEqual(payload["exc_hash"], self.rule.exception_hash())
        self.assertEqual(payload["dir"], "fwd")


class TestCursorMismatch(unittest.TestCase):
    def setUp(self):
        self.cal = BusinessCalendar()
        self.zone = get_zone("UTC")
        self.rule = make_rule()
        self.cursor = paginate(self.rule, self.cal, self.zone, START, END,
                               page_size=3).next_cursor

    def test_old_cursor_rejected_after_rule_version_bump(self):
        new_rule = self.rule.updated(adjust="following")
        with self.assertRaises(CursorMismatch):
            paginate(new_rule, self.cal, self.zone, START, END,
                     page_size=3, cursor=self.cursor)

    def test_old_cursor_rejected_after_exception_change(self):
        new_rule = self.rule.updated(remove_dates=(date(2024, 3, 31),))
        with self.assertRaises(CursorMismatch):
            paginate(new_rule, self.cal, self.zone, START, END,
                     page_size=3, cursor=self.cursor)

    def test_cursor_rejected_for_different_range(self):
        with self.assertRaises(CursorMismatch):
            paginate(self.rule, self.cal, self.zone, START, utc(2027, 1, 1),
                     page_size=3, cursor=self.cursor)

    def test_garbage_cursor_rejected(self):
        with self.assertRaises(CursorMismatch):
            paginate(self.rule, self.cal, self.zone, START, END,
                     page_size=3, cursor="not-a-cursor")

    def test_recovery_after_rule_modification(self):
        # After modifying the rule, a fresh cursor chain works and the
        # old cursor never mixes old results into the new version.
        new_rule = self.rule.updated(remove_dates=(date(2024, 3, 31),))
        page1 = paginate(new_rule, self.cal, self.zone, START, END,
                         page_size=100)
        self.assertNotIn(date(2024, 3, 31),
                         [o.local_date for o in page1.occurrences])
        self.assertEqual([r["date"] for r in page1.removed], ["2024-03-31"])
        # fresh pagination of the new rule reassembles its expansion
        full = expand(new_rule, self.cal, self.zone, START, END).occurrences
        collected, cursor = [], None
        while True:
            page = paginate(new_rule, self.cal, self.zone, START, END,
                            page_size=7, cursor=cursor)
            collected.extend(page.occurrences)
            if not page.has_more:
                break
            cursor = page.next_cursor
        self.assertEqual([o.utc for o in collected], [o.utc for o in full])


if __name__ == "__main__":
    unittest.main()
