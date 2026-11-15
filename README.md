# 倒排索引删除世代

索引构建器需要可嵌入 C++ segment 删除状态库，以 doc id、segment generation 和 delete generation 管理 bitset。merge 只携带在其快照可见的删除，期间新删除重映射到输出 segment；旧 generation 回执不能覆盖新 bitset。逐文档可见性与参考模型一致。

## API 概览

库为单头/单实现文件（`dataeng.hpp` / `dataeng.cpp`），C++20，无第三方依赖，可直接嵌入索引构建器。非线程安全，调用方需自行同步。

- `dataeng::SegmentDeletes`：单个 segment generation 的删除状态。bitset 按 doc id 索引，每个 bit 伴随设置它的 delete generation 作为回执守卫。
  - `apply_delete(del_gen, doc)`：回执的 delete generation 不新于该文档已记录的 generation 时视为过期，直接丢弃——旧回执永远不会覆盖新 bitset。
  - `is_deleted(doc)` / `delete_generation_of(doc)` / `is_visible_at(doc, snapshot)`：逐文档可见性查询；文档可见当且仅当没有 `del_gen <= snapshot` 的删除记录。
- `dataeng::DeletionRegistry`：管理所有存活 segment 的删除状态并编排 merge。
  - `open_segment(id, gen)`：以更新的 segment generation 重开会重置删除状态；不更新的 generation 为 no-op。
  - `apply_delete(id, seg_gen, del_gen, doc)`：`seg_gen` 与 segment 当前 generation 不匹配（过期回执）时拒绝。
  - `begin_merge(spec, snapshot)` / `commit_merge()` / `abort_merge()`：merge 只携带快照内可见（`del_gen <= snapshot`）的删除；merge 期间落到输入 segment 的新删除在 commit 时经 `doc_maps` 重映射到输出 segment；`kDroppedDoc` 表示 merge reader 未携带的文档。

## 构建与测试

```sh
cmake -B build && cmake --build build
ctest --test-dir build --output-on-failure
```

测试（`tests/test_deletes.cpp`）包含确定性用例，以及 20000 步随机操作（开/删/关/merge/abort、过期回执注入）与独立参考模型的逐文档可见性对比。
