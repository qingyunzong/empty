"""Minimize the deterministic A compaction counterexample."""
import importlib.util
import json
import random
import sys


spec = importlib.util.spec_from_file_location("submitted_orset", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ORSet = module.ORSet


def clone(state):
    return ORSet.from_json(json.loads(json.dumps(state.to_json())))


def run(events, verbose=False):
    compacted = {n: ORSet(n) for n in "ABC"}
    control = {n: ORSet(n) for n in "ABC"}
    for ev in events:
        kind, n, *rest = ev
        if kind == "merge":
            compacted[n].merge(clone(compacted[rest[0]]))
            control[n].merge(clone(control[rest[0]]))
        elif kind == "compact":
            compacted[n].compact()
        else:
            getattr(compacted[n], kind)(rest[0])
            getattr(control[n], kind)(rest[0])
    mismatch = [(n, e) for n in "ABC" for e in "xyz" if compacted[n].contains(e) != control[n].contains(e)]
    if verbose:
        print("EVENTS", json.dumps(events))
        print("MISMATCH", mismatch)
        for n, e in mismatch:
            print("COMPACTED", n, e, json.dumps(compacted[n].to_json(), sort_keys=True))
            print("CONTROL", n, e, json.dumps(control[n].to_json(), sort_keys=True))
    return bool(mismatch)


rng = random.Random(11)
events = []
for _ in range(59):
    n = rng.choice("ABC")
    e = rng.choice("xyz")
    kind = rng.choices(["add", "remove", "merge", "compact"], [35, 25, 30, 10])[0]
    if kind == "merge":
        events.append((kind, n, rng.choice([v for v in "ABC" if v != n])))
    elif kind == "compact":
        events.append((kind, n))
    else:
        events.append((kind, n, e))
assert run(events)

n = 2
while n <= len(events):
    chunk = max(1, len(events) // n)
    found = False
    for start in range(0, len(events), chunk):
        trial = events[:start] + events[start + chunk:]
        if run(trial):
            events = trial
            n = max(2, n - 1)
            found = True
            break
    if not found:
        if chunk == 1:
            break
        n = min(len(events), n * 2)
print("MINIMIZED_EVENT_COUNT", len(events))
run(events, True)
