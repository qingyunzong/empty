"""Check whether compact(nodes) verifies that each node saw a deletion."""

import importlib.util
import pathlib
import sys


def main():
    sys.dont_write_bytecode = True
    source = pathlib.Path.cwd() / "orset.py"
    spec = importlib.util.spec_from_file_location("submitted_orset", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    a = module.ORSet("A")
    a.add("x")
    b = module.ORSet("B").merge(a)
    b.remove("x")
    before = b.to_json()
    if not a.contains("x") or len(before["dead"].get("x", [])) != 1:
        print("前置状态未建立：A 应仍有 x，B 应持有一条删除标签")
        return 1

    after = module.handle("compact", {"state": before, "nodes": ["A", "B"]})
    dead_count = len(after["dead"].get("x", []))
    watermark = after["summary"].get("x", {}).get("A")
    a_still_has_x = a.contains("x")
    merged_has_x = a.merge(module.ORSet.from_json(after)).contains("x")
    print(f"A 尚未收到删除，contains(x): {a_still_has_x}")
    print(f"B 压缩前删除标签: {len(before['dead']['x'])}")
    print(f"B 压缩后删除标签: {dead_count}；A 标签水位: {watermark}")
    print(f"后续合并 contains(x): {merged_has_x}")
    if a_still_has_x and dead_count == 0 and watermark == 0 and not merged_has_x:
        print("复现：未满足全节点观察条件，删除仍被折入水位")
        return 0
    print("未复现：压缩结果与预期缺点不符")
    return 1


if __name__ == "__main__":
    sys.exit(main())
