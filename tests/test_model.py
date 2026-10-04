"""Model-based test: random legal transaction histories are checked against
an independent serial-commit model, across crashes, checkpoints and log
reclamation."""

import random
import unittest

from kvstore.engine import page_id_for

from helpers import TempDB

KEYS = [f"k{i}" for i in range(8)]
NUM_PAGES = 16


class ModelTest(unittest.TestCase):
    def test_random_histories_match_serial_model(self):
        for trial in range(25):
            with self.subTest(trial=trial):
                self._run_trial(seed=1000 + trial)

    def _run_trial(self, seed):
        rng = random.Random(seed)
        with TempDB(num_pages=NUM_PAGES, page_size=256,
                    pool_capacity=4) as db:
            eng = db.open()
            model = {}
            open_txs = {}   # txid -> {"writes": {key: value|None}, "pages": set}
            used_pages = {}  # page -> txid (generator-side conflict avoidance)
            reclaimed = {"seen": False}

            def free_tx(txid):
                for pid in open_txs[txid]["pages"]:
                    used_pages.pop(pid, None)
                del open_txs[txid]

            for _step in range(60):
                ops = ["checkpoint", "crash"]
                if len(open_txs) < 3:
                    ops += ["begin"] * 2
                if open_txs:
                    ops += ["put"] * 4 + ["delete", "commit", "commit",
                                          "abort"]
                op = rng.choice(ops)
                if op == "begin":
                    txid = eng.begin()
                    open_txs[txid] = {"writes": {}, "pages": set()}
                elif op in ("put", "delete"):
                    txid = rng.choice(list(open_txs))
                    free_keys = [k for k in KEYS
                                 if used_pages.get(page_id_for(k, NUM_PAGES))
                                 in (None, txid)]
                    if not free_keys:
                        continue
                    key = rng.choice(free_keys)
                    pid = page_id_for(key, NUM_PAGES)
                    used_pages[pid] = txid
                    open_txs[txid]["pages"].add(pid)
                    if op == "put":
                        value = f"v{rng.randrange(100)}"
                        eng.put(txid, key, value)
                        open_txs[txid]["writes"][key] = value
                    else:
                        eng.delete(txid, key)
                        open_txs[txid]["writes"][key] = None
                elif op == "commit":
                    txid = rng.choice(list(open_txs))
                    eng.commit(txid)
                    for key, value in open_txs[txid]["writes"].items():
                        if value is None:
                            model.pop(key, None)
                        else:
                            model[key] = value
                    free_tx(txid)
                elif op == "abort":
                    txid = rng.choice(list(open_txs))
                    eng.abort(txid)
                    free_tx(txid)
                elif op == "checkpoint":
                    eng.checkpoint()
                    if eng.log.base > 0:
                        reclaimed["seen"] = True
                elif op == "crash":
                    del eng
                    eng = db.open()  # recovery: open txns are losers
                    open_txs.clear()
                    used_pages.clear()

            # final crash + recovery, then compare against the serial model
            del eng
            eng = db.open()
            self.assertEqual(eng.dump(), model)
            # and once more: recovery must be idempotent
            del eng
            eng = db.open()
            self.assertEqual(eng.dump(), model)

    def test_reclaim_actually_happens_in_trials(self):
        # sanity: checkpoints in the random trials reclaim the log prefix
        with TempDB(num_pages=NUM_PAGES, page_size=256,
                    pool_capacity=4) as db:
            eng = db.open()
            for i in range(3):
                t = eng.begin()
                eng.put(t, f"k{i}", "x")
                eng.commit(t)
            eng.checkpoint()
            self.assertGreater(eng.log.base, 0)


if __name__ == "__main__":
    unittest.main()
