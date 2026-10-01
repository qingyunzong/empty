"""Compare compacted replicas with an uncompacted control under the same events."""
import importlib.util
import json
import random
import sys


def load(path):
    spec = importlib.util.spec_from_file_location("submitted_orset", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.ORSet


def copy(cls, state):
    return cls.from_json(json.loads(json.dumps(state.to_json())))


def merge(side, dst, src):
    if side == "A":
        dst.merge(src)
        return dst
    return dst.merge(src)


def run(side, cls):
    for seed in range(100):
        rng = random.Random(seed)
        names = "ABC"
        compacted = {n: cls(n) for n in names}
        control = {n: cls(n) for n in names}
        history = []
        for step in range(100):
            n = rng.choice(names)
            e = rng.choice("xyz")
            kind = rng.choices(["add", "remove", "merge", "compact"], [35, 25, 30, 10])[0]
            if kind == "merge":
                source = rng.choice([v for v in names if v != n])
                compacted[n] = merge(side, compacted[n], copy(cls, compacted[source]))
                control[n] = merge(side, control[n], copy(cls, control[source]))
                history.append((kind, n, source))
            elif kind == "compact":
                if side == "A":
                    compacted[n].compact()
                else:
                    compacted[n].compact(list(names))
                history.append((kind, n))
            else:
                getattr(compacted[n], kind)(e)
                getattr(control[n], kind)(e)
                history.append((kind, n, e))
            for rep in names:
                for elem in "xyz":
                    actual = compacted[rep].contains(elem)
                    expected = control[rep].contains(elem)
                    if actual != expected:
                        print("MISMATCH", side, "seed", seed, "step", step, "replica", rep, "element", elem, "actual", actual, "expected", expected)
                        print("EVENTS", json.dumps(history))
                        print("COMPACTED", json.dumps(compacted[rep].to_json(), sort_keys=True))
                        print("CONTROL", json.dumps(control[rep].to_json(), sort_keys=True))
                        return 1
    print("PASS", side, "100 seeds x 100 events; all replica contains matched uncompacted control")
    return 0


if __name__ == "__main__":
    side, path = sys.argv[1:]
    sys.exit(run(side, load(path)))
