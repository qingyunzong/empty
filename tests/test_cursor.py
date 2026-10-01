import unittest
from datetime import date, datetime

from billcal.engine import StaleCursorError, expand, paginate
from billcal.model import Rule


def ts(iso):
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())


START, END = ts("2021-01-01T00:00:00Z"), ts("2023-01-01T00:00:00Z")
RULE = Rule(anchor=date(2021, 1, 31), tz="UTC")


def forward_chain(rule, limit):
    pages, cursor = [], None
    while True:
        page = paginate(rule, START, END, limit=limit, cursor=cursor,
                        direction="forward")
        pages.append(page)
        if page.next_cursor is None:
            return pages
        cursor = page.next_cursor


class TestForwardPagination(unittest.TestCase):
    def test_chain_equals_full_expansion(self):
        full = [o.to_dict() for o in expand(RULE, START, END).occurrences]
        chained = [o.to_dict() for p in forward_chain(RULE, 5)
                   for o in p.occurrences]
        self.assertEqual(chained, full)
        self.assertEqual(len(chained), 24)

    def test_page_sizes(self):
        pages = forward_chain(RULE, 5)
        self.assertEqual([len(p.occurrences) for p in pages], [5, 5, 5, 5, 4])


class TestBackwardPagination(unittest.TestCase):
    def test_reverse_chain_equals_full_expansion(self):
        full = [o.to_dict() for o in expand(RULE, START, END).occurrences]
        pages, cursor = [], None
        while True:
            page = paginate(RULE, START, END, limit=5, cursor=cursor,
                            direction="backward")
            pages.append(page)
            if page.prev_cursor is None:
                break
            cursor = page.prev_cursor
        chained = [o.to_dict() for p in reversed(pages) for o in p.occurrences]
        self.assertEqual(chained, full)
        # Last page (first fetched) holds the newest occurrences.
        self.assertEqual(pages[0].occurrences[-1].to_dict(), full[-1])

    def test_backward_page_sizes(self):
        sizes, cursor = [], None
        while True:
            page = paginate(RULE, START, END, limit=5, cursor=cursor,
                            direction="backward")
            sizes.append(len(page.occurrences))
            if page.prev_cursor is None:
                break
            cursor = page.prev_cursor
        self.assertEqual(sizes, [5, 5, 5, 5, 4])


class TestStaleCursor(unittest.TestCase):
    def _cursor(self, rule=RULE):
        return paginate(rule, START, END, limit=5).next_cursor

    def test_version_bump_invalidates(self):
        cursor = self._cursor()
        newer = RULE.with_changes(version=2)
        with self.assertRaises(StaleCursorError):
            paginate(newer, START, END, limit=5, cursor=cursor)

    def test_exception_change_invalidates(self):
        cursor = self._cursor()
        changed = RULE.with_changes(
            exceptions_add=frozenset({datetime(2021, 6, 15, 9, 0)}))
        with self.assertRaises(StaleCursorError):
            paginate(changed, START, END, limit=5, cursor=cursor)

    def test_anchor_change_invalidates(self):
        cursor = self._cursor()
        changed = RULE.with_changes(anchor=date(2021, 2, 28))
        with self.assertRaises(StaleCursorError):
            paginate(changed, START, END, limit=5, cursor=cursor)

    def test_recovery_after_rule_change(self):
        # After a rule change, a fresh expansion issues cursors that work.
        changed = RULE.with_changes(
            exceptions_add=frozenset({datetime(2021, 6, 15, 9, 0)}),
            version=2)
        full = [o.to_dict() for p in forward_chain(changed, 5)
                for o in p.occurrences]
        self.assertEqual(len(full), 25)  # 24 + 1 exception
        self.assertEqual(full, [o.to_dict() for o in
                                expand(changed, START, END).occurrences])

    def test_garbage_cursor_rejected(self):
        with self.assertRaises(StaleCursorError):
            paginate(RULE, START, END, limit=5, cursor="not-a-cursor")


if __name__ == "__main__":
    unittest.main()
