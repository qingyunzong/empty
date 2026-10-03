import json
import unittest
from fractions import Fraction

from ridag.dag import DAG
from ridag.evaluator import Evaluator
from ridag.interval import End, Interval, IntervalUnion
from ridag.jsonio import (dag_to_json, dag_from_json, interval_to_json,
                          interval_from_json, union_to_json, union_from_json,
                          expr_from_json, cert_to_json)
from ridag.newton import Isolator, UNIQUE
from ridag.cert import verify_certificate


class TestIntervalJSON(unittest.TestCase):
    def test_roundtrip(self):
        cases = [
            Interval(End(0), True, End(Fraction(22, 7)), False),
            Interval(End.inf(-1), True, End(0), True),
            Interval.point(End(Fraction(-3, 5))),
            Interval(End(1), False, End.inf(1), True),
        ]
        for iv in cases:
            back = interval_from_json(json.loads(json.dumps(
                interval_to_json(iv))))
            self.assertEqual(iv, back)

    def test_union_roundtrip(self):
        u = IntervalUnion([
            Interval(End.inf(-1), True, End(0), True),
            Interval(End(0), True, End.inf(1), True),
        ])
        back = union_from_json(json.loads(json.dumps(union_to_json(u))))
        self.assertEqual(u, back)
        self.assertEqual(len(back), 2)


class TestDAGJSON(unittest.TestCase):
    def test_roundtrip_evaluates_equal(self):
        dag = DAG()
        x = dag.var("x")
        f = dag.div(dag.add(dag.pow(x, 3), dag.const(Fraction(1, 7))),
                    dag.sub(x, dag.const(2)))
        f = dag.cond(dag.sub(x, 1), f, dag.neg(f))
        blob = json.dumps(dag_to_json(dag, f))
        dag2, g = dag_from_json(json.loads(blob))
        ev1, ev2 = Evaluator(dag), Evaluator(dag2)
        box = IntervalUnion([Interval.closed(End(3), End(4))])
        ev1.set("x", box)
        ev2.set("x", box)
        self.assertEqual(ev1.eval(f).value, ev2.eval(g).value)

    def test_expr_from_json(self):
        dag = DAG()
        f = expr_from_json(dag, {"div": [{"add": [{"var": "x"}, {"const": "1/2"}]},
                                         {"pow": [{"var": "x"}, 2]}]})
        ev = Evaluator(dag)
        ev.set("x", IntervalUnion([Interval.point(End(2))]))
        v = ev.eval(f).value.as_interval()
        self.assertEqual(v.lo.val, Fraction(5, 8))


class TestSaveRestore(unittest.TestCase):
    def test_certificate_save_load_verify(self, tmp="/tmp/ridag_cert_test.json"):
        dag = DAG()
        x = dag.var("x")
        f = dag.div(dag.sub(dag.pow(x, 2), dag.const(2)),
                    dag.sub(x, dag.const(5)))
        dom = IntervalUnion([Interval.closed(End(-10), End(10))])
        cert = Isolator(dag, f, "x", dom, eps=Fraction(1, 10 ** 12)).isolate()
        blob = cert_to_json(cert)
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(blob, fh)
        with open(tmp, "r", encoding="utf-8") as fh:
            loaded = json.load(fh)
        ok, errors = verify_certificate(loaded)
        self.assertTrue(ok, errors)
        roots = [c for c in loaded["claims"] if c["status"] == "unique_root"]
        self.assertEqual(len(roots), 2)  # +/- sqrt(2), pole at 5 is a hole

    def test_env_save_restore_rollback(self):
        dag = DAG()
        x = dag.var("x")
        f = dag.add(x, dag.const(1))
        ev = Evaluator(dag)
        ev.set("x", IntervalUnion([Interval.closed(End(0), End(10))]))
        token = ev.snapshot()
        ev.set("x", IntervalUnion([Interval.closed(End(0), End(1))]))
        self.assertEqual(ev.eval(f).value.as_interval().hi.val, 2)
        ev.restore(token)
        self.assertEqual(ev.eval(f).value.as_interval().hi.val, 11)


if __name__ == "__main__":
    unittest.main()
