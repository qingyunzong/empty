import random
import unittest

from dreach import Engine, UnknownSavepointError


def warshall(n, edges):
    reachable = [[i == j for j in range(n)] for i in range(n)]
    for u, v in edges:
        reachable[u][v] = True

    for k in range(n):
        for i in range(n):
            if not reachable[i][k]:
                continue
            row_k = reachable[k]
            row_i = reachable[i]
            for j in range(n):
                row_i[j] = row_i[j] or row_k[j]
    return reachable


def lex_shortest_paths(n, edges, source):
    adjacency = [[] for _ in range(n)]
    for u, v in edges:
        adjacency[u].append(v)
    for neighbors in adjacency:
        neighbors.sort()

    paths = {source: [source]}
    frontier = {source}
    while frontier:
        next_frontier = {}
        for u in range(n):
            if u not in frontier:
                continue
            for v in adjacency[u]:
                if v in paths:
                    continue
                candidate = paths[u] + [v]
                current = next_frontier.get(v)
                if current is None or candidate < current:
                    next_frontier[v] = candidate
        paths.update(next_frontier)
        frontier = next_frontier
    return paths


def assert_graph_matches(test_case, engine, n, edges):
    expected_reachable = warshall(n, edges)
    for u in range(n):
        expected_paths = lex_shortest_paths(n, edges, u)
        for v in range(n):
            test_case.assertIs(
                engine.reachable(u, v),
                expected_reachable[u][v],
                (u, v, edges),
            )
            expected_witness = expected_paths.get(v)
            test_case.assertEqual(
                engine.witness(u, v),
                expected_witness,
                (u, v, edges),
            )


class EngineAcceptanceTest(unittest.TestCase):
    def test_insert_disappears_after_rollback(self):
        engine = Engine()
        engine.init(4)
        engine.insert(0, 1)
        savepoint = engine.savepoint()
        engine.insert(1, 2)

        self.assertTrue(engine.reachable(0, 2))

        engine.rollback(savepoint)

        self.assertFalse(engine.reachable(0, 2))
        self.assertIsNone(engine.witness(0, 2))

    def test_deleted_edge_path_reappears_after_rollback(self):
        engine = Engine()
        engine.init(4)
        engine.insert(0, 1)
        engine.insert(1, 3)
        engine.insert(0, 2)
        engine.insert(2, 3)
        savepoint = engine.savepoint()
        engine.delete(0, 1)

        self.assertEqual(engine.witness(0, 3), [0, 2, 3])

        engine.delete(0, 2)
        self.assertFalse(engine.reachable(0, 3))

        engine.rollback(savepoint)

        self.assertTrue(engine.reachable(0, 3))
        self.assertEqual(engine.witness(0, 3), [0, 1, 3])

    def test_unknown_rollback_keeps_current_state(self):
        engine = Engine()
        engine.init(3)
        engine.insert(0, 1)
        savepoint = engine.savepoint()
        engine.insert(1, 2)

        with self.assertRaises(UnknownSavepointError):
            engine.rollback(999)

        self.assertEqual(engine.snapshot_for_testing(), (3, {(0, 1), (1, 2)}))
        self.assertEqual(engine.witness(0, 2), [0, 1, 2])
        self.assertTrue(engine.reachable(0, 2))

        engine.rollback(savepoint)
        with self.assertRaises(UnknownSavepointError):
            engine.rollback(savepoint + 1)
        self.assertEqual(engine.snapshot_for_testing(), (3, {(0, 1)}))

    def test_unreachable_witness_is_null(self):
        engine = Engine()
        engine.init(3)
        engine.insert(0, 1)

        self.assertFalse(engine.reachable(1, 0))
        self.assertIsNone(engine.witness(1, 0))

    def test_duplicate_edges_are_idempotent_and_lex_order_is_used(self):
        engine = Engine()
        engine.init(4)
        engine.insert(0, 2)
        engine.insert(0, 2)
        engine.insert(0, 1)
        engine.insert(1, 2)
        engine.insert(2, 3)

        self.assertEqual(engine.snapshot_for_testing()[1], {(0, 1), (0, 2), (1, 2), (2, 3)})
        self.assertEqual(engine.witness(0, 2), [0, 2])
        self.assertEqual(engine.witness(0, 3), [0, 2, 3])

        engine.delete(0, 2)
        engine.delete(0, 2)
        self.assertEqual(engine.witness(0, 2), [0, 1, 2])

    def test_savepoint_ids_are_monotonic(self):
        engine = Engine()
        engine.init(3)
        first = engine.savepoint()
        engine.insert(0, 1)
        second = engine.savepoint()
        engine.insert(1, 2)

        self.assertEqual((first, second), (1, 2))

        engine.rollback(first)
        third = engine.savepoint()
        self.assertEqual(third, 3)
        self.assertEqual(engine.snapshot_for_testing()[1], set())

        with self.assertRaises(UnknownSavepointError):
            engine.rollback(second)


class IndependentOracleTest(unittest.TestCase):
    def test_random_sequences_against_warshall_and_bfs(self):
        rng = random.Random(20260927)
        for _ in range(20):
            self._run_random_sequence(rng, rng.randint(1, 8), 50)

    def test_n16_sequence_against_warshall_and_bfs(self):
        rng = random.Random(2026092716)
        self._run_random_sequence(rng, 16, 70)

    def _run_random_sequence(self, rng, n, steps):
        engine = Engine()
        engine.init(n)
        edges = set()
        snapshots = {}
        next_savepoint = 1

        assert_graph_matches(self, engine, n, edges)

        for _ in range(steps):
            action = rng.randrange(10)
            if action < 4:
                edge = (rng.randrange(n), rng.randrange(n))
                engine.insert(*edge)
                edges.add(edge)
            elif action < 7:
                edge = (rng.randrange(n), rng.randrange(n))
                engine.delete(*edge)
                edges.discard(edge)
            elif action == 7 or not snapshots:
                savepoint_id = next_savepoint
                next_savepoint += 1
                self.assertEqual(engine.savepoint(), savepoint_id)
                snapshots[savepoint_id] = (n, set(edges))
            else:
                savepoint_id = rng.choice(list(snapshots))
                n, restored_edges = snapshots[savepoint_id]
                edges = set(restored_edges)
                engine.rollback(savepoint_id)
                for stale_id in [sid for sid in snapshots if sid > savepoint_id]:
                    del snapshots[stale_id]

            self.assertEqual(engine.snapshot_for_testing(), (n, edges))
            assert_graph_matches(self, engine, n, edges)


if __name__ == "__main__":
    unittest.main()
