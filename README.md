# 模糊地址分词候选图

可嵌入的 C++20 地址候选分词库。它依据版本化行政区词典和别名，在 Unicode
字符区间上生成有向无环候选图，并返回 Top-N 候选路径；库本身不替业务选择
唯一地址。

## 特性

- 词典快照带 `version`，候选图和候选路径都会携带该版本。
- 匹配位置使用 Unicode 码点区间，同时保留原始 UTF-8 字节区间和原文切片。
- 同名、别名、长短匹配全部保留；重叠候选在图中共存。
- 未被任何词典项覆盖的连续片段生成一条未知边，未知字符同时保留单字符回退边，
  保证重叠匹配下仍存在完整路径。
- Top-N 路径按 `(total_cost, stable_key)` 排序；稳定键只由 span、边类型和词典
  ID 构成，与哈希顺序、词典插入顺序无关。
- 无第三方依赖，构建后可静态链接进地址清洗服务。

## 使用

```cpp
#include "dataeng.hpp"

dataeng::AdminDictionary dictionary("2026.1");
dictionary
    .add("110000", "北京市", {"北京"}, dataeng::RegionLevel::City)
    .add("110105", "朝阳区", {"朝阳"}, dataeng::RegionLevel::District,
         "110000");

dataeng::SegmenterOptions options;
options.name_cost = 1;          // 精确名称边代价
options.alias_cost = 2;         // 别名边代价
options.unknown_char_cost = 100; // 每个未知字符的代价

dataeng::AddressSegmenter segmenter(std::move(dictionary), options);

dataeng::CandidateGraph graph = segmenter.build_graph("北京市朝阳区");
std::vector<dataeng::CandidatePath> candidates = graph.top_paths(10);

for (const auto& path : candidates) {
    // path.total_cost, path.stable_key, path.edges ...
    // path.edges[i].span    -> 码点区间 [begin, end)
    // path.edges[i].bytes   -> 原始 UTF-8 字节区间
    // path.edges[i].text    -> 原文切片
    // path.edges[i].kind    -> Name / Alias / Unknown
    // path.edges[i].cost
}
```

`AddressSegmenter` 构造时复制词典快照并建立码点 trie。之后修改原来的
`AdminDictionary` 不会影响已经构造的 segmenter；需要切换词典版本时创建新的
segmenter 即可。`build_graph()` 只读 segmenter 内部状态，可并发调用。

## 图与代价

- 节点是输入文本的字符边界，范围为 `[0, character_count]`。
- 每条词典边对应一个原文区间；`name` 和每个 `alias` 分别生成边，短匹配不会
  覆盖长匹配。
- 每个字符都有一条 `Unknown` 单字符回退边。若某段连续字符完全没有词典覆盖，
  还会生成一条整段 `Unknown` 边，代价为“未知字符数 × `unknown_char_cost`”。
- 边的代价默认是：名称 1、别名 2、每个未知字符 100；可通过
  `SegmenterOptions` 调整。`DictionaryEntry::extra_cost` 会累加到该词条的所有
  边上，用于表达数据质量差异。
- `top_paths(n)` 在 DAG 上按节点反向保留 Top-N 后缀，最终按总代价升序、稳定键
  升序返回。相同代价的不同切分不会互相覆盖。
- 空输入返回一条空路径（代价 0）。

## 构建与测试

```bash
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```
