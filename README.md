# Unicode 标识规范化血缘

可嵌入的 C++20 Unicode 标识规范化库。按固定顺序执行 **Unicode 16.0.0 NFKC →
full case fold → 默认可忽略字符策略 → 脚本限制**，为每个输出码点保留原始输入中的
字节区间血缘，并在批量折叠时显式报告冲突组。非法 UTF-8 按 Unicode 最大子部件
（maximal subpart）规则精确隔离，不会与相邻文本发生组合。

## 构建与测试

```sh
cmake -S . -B build -DDATAENG_BUILD_TESTS=ON
cmake --build build -j
ctest --test-dir build --output-on-failure
```

库目标为 `dataeng`，公共头文件为 `dataeng.hpp`。Unicode 表编译进
`dataeng.cpp`（`unicode_tables.inc`），运行时不依赖 ICU、Python 或 Node.js。

## 快速使用

```cpp
#include "dataeng.hpp"

dataeng::NormalizeOptions options;
options.ignorables = dataeng::IgnorablePolicy::Remove;   // 默认
options.scripts = dataeng::ScriptPolicy::RejectDisallowed;
options.allowed_scripts = {"Latin"};

dataeng::Normalizer normalizer(options);
dataeng::NormalizeResult result = normalizer.normalize("Ａ\xC3\x9F" "e");

for (const auto& cp : result.code_points) {
    // cp.value 是规范化后的码点；cp.source 是 [begin, end) 原始字节区间。
    // 「Ａ」分解/折叠出的多个码点共享同一个 source 区间。
}

if (!result.valid()) {
    // result.diagnostics 含 InvalidUtf8 / DisallowedIgnorable / DisallowedScript。
}
```

批量冲突检测：

```cpp
std::vector<std::string> inputs = {"Straße", "STRASSE", "strasse"};
dataeng::BatchResult batch = dataeng::normalize_identifiers(inputs);

// batch.entries.size() == 3：从不静默去重。
// batch.conflicts[0].key == "strasse"
// batch.conflicts[0].entries == {0, 1, 2}
// batch.conflicts[0].distinct_originals.size() == 3
```

## 语义

**管线顺序**：先对每个合法 UTF-8 run 做完整 NFKD 分解、规范重排和规范组合
（即 NFKC），再逐码点执行 full case fold，然后应用默认可忽略策略，最后检查
Script / Script_Extensions。每一步都在上一阶段的输出上继续保留血缘。

**字节血缘**：`CodePoint::source` 为半开区间。分解与 case folding 展开时所有产物
继承源码点区间；规范组合时取参与码点区间的并集（`begin` 最小值、`end` 最大值）。
被 `Remove` 策略删除的码点记录在 `removals` 中，同样带源区间。

**默认可忽略字符**：由 `IgnorablePolicy` 控制：

- `Remove`（默认）：删除并记录 `removals`。
- `Keep`：保留。
- `Reject`：保留以便查看，同时产生 `DisallowedIgnorable` 诊断并使结果无效。

**脚本限制**：`allowed_scripts` 接受规范脚本名（如 `Latin`、`Han`）以及常见
ISO 15924 别名（如 `Latn`、`Hani`），大小写及 `_`/`-`/空格不敏感。空列表表示
不限制。`Common` 与 `Inherited` 视为中性码点；存在 Script_Extensions 时按扩展
脚本集合判断（例如 U+30FC 可随 Hiragana 使用）。`ScriptPolicy` 可选
`AllowAll`、`RemoveDisallowed`、`RejectDisallowed`。`BatchResult` 冲突分组只
包含完全有效（无诊断）的条目；无效条目仍保留在 `entries` 中。

**非法 UTF-8**：解码器输出连续的合法 run 与逐个非法 max-subpart。非法片段
`Segment::valid_utf8 == false` 且没有码点，各合法 run 独立规范化，因此例如
`e <bad> U+0301` 不会被组合成 `é`。`invalid_utf8_ranges()` 返回精确区间；
`key` 仅拼接合法 run 的输出，调用方应同时检查 `valid()` /
`has_invalid_utf8()`。

**版本**：内嵌版本为 `16.0.0`。`NormalizeOptions::unicode_version` 接受
`16`、`16.0`、`16.0.0`、`latest`（及带 `Unicode` 前缀的形式）；其他版本抛出
`std::invalid_argument`，避免用错误版本的数据静默处理。

## Unicode 表

`unicode_tables.inc` 由 `tools/generate_unicode_data.py` 生成：

- NFKC 分解、组合、canonical combining class、full case fold：Python
  `unicodedata`（Unicode 16.0.0）。
- `Default_Ignorable_Code_Point`、`Script`、`Script_Extensions`：
  `regenerate-unicode-properties`，并按 Unicode 16.0.0 已分配码点过滤，使整库
  呈现一致的 16.0.0 语义。

重新生成：

```sh
python3 tools/generate_unicode_data.py
```

## 主要 API

- `Normalizer::normalize(std::string_view)` / `normalize_identifier(...)`
- `normalize_identifiers(span / vector / initializer_list)`
- `NormalizeResult::{code_points, segments, diagnostics, removals, key, valid(...)}`
- `BatchResult::{entries, groups, conflicts, valid}`
- `unicode::{version, script, script_extensions, canonical_combining_class,
  is_default_ignorable}`
- `validate_utf8`、`to_utf8`
