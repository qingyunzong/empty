"""Read-only probes against the submitted OR-Set modules (Python 3.11)."""
import importlib.util
import json
import sys


def load(path):
    spec = importlib.util.spec_from_file_location("submitted_orset", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.ORSet


def run_a(cls):
    a = cls("A")
    a.add("x")
    b = cls("B")
    b.merge(cls.from_json(a.to_json()))
    a.merge(cls.from_json(b.to_json()))
    before = json.dumps(a.to_json(), sort_keys=True)
    made = a.compact()
    after = json.dumps(a.to_json(), sort_keys=True)
    print("A compact made:", made)
    print("A bytes before/after:", len(before), len(after))
    print("A covered:", a.to_json()["summaries"]["x"][0]["covered"])
    b.remove("x")
    a.merge(cls.from_json(b.to_json()))
    print("A observed remove after compact contains:", a.contains("x"))


def run_b(cls):
    a = cls("A")
    a.add("x")
    b = cls("B").merge(a)
    b.remove("x")
    print("B precompact dead:", b.to_json()["dead"])
    print("B precompact summary:", b.to_json()["summary"])
    b.compact(["A", "B"])
    print("B compact before A receives remove, dead:", b.to_json()["dead"])
    print("B compact before A receives remove, summary:", b.to_json()["summary"])
    print("B A still contains:", a.contains("x"))
    merged = a.merge(b)
    print("B after delivery contains:", merged.contains("x"))


if __name__ == "__main__":
    side, path = sys.argv[1:]
    cls = load(path)
    {"A": run_a, "B": run_b}[side](cls)
