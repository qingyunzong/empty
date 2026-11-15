# XML 外部实体禁用下的流切片

文档采集管线要嵌入可嵌入的 C++ XML 流切片库，在禁止外部实体的前提下处理 namespace、CDATA、内部实体和跨块 token，按指定元素路径交付子树。实体展开设总预算；未闭合元素返回原始偏移，先前完整 sibling 仍可提交。

## 模块

- `xml_slicer.hpp` / `xml_slicer.cpp`：零依赖、C++20、单文件可嵌入的流切片库（命名空间 `dataeng::xml`）。
- `tests/test_xml_slicer.cpp`：1200+ 断言的单元与分块模糊测试，通过 CTest 运行。

## 特性

- **流式跨块 token**：任意大小的 `feed()` 分块，标签、CDATA、注释、实体引用可在任意字节边界切开，库内部缓冲直到 token 完整。
- **路径切片**：按元素路径（`/root/record/item`）交付完整子树的原始字节与流内绝对偏移；支持 Clark 记法命名空间路径（`/{urn:ns}root/{urn:ns}item`）、qname 路径与 `*` 单段通配；支持嵌套路径同时切片。
- **命名空间**：解析 `xmlns` / `xmlns:prefix` 声明（含作用域遮蔽），元素名解析为 `{uri}local`。
- **CDATA / 注释 / PI**：CDATA、注释、处理指令原样保留在切片原始字节中；XML 声明仅接受 UTF-8。
- **内部实体**：支持内部子集 `<!ENTITY name "value">`，实体延迟展开，支持嵌套与字符引用（`&#65;` / `&#x41;`）。
- **外部实体禁用**：外部 DTD（`SYSTEM`/`PUBLIC`）、外部/未解析实体、参数实体声明与引用一律拒绝，返回 `ErrorCode::ExternalEntity`，不产生任何网络或文件访问。
- **实体展开总预算**：`entity_expansion_budget` 对全文实体展开输出累计计费，超限返回 `EntityBudgetExceeded`，可抵御 billion laughs；递归/超深引用返回 `EntityRecursion`。
- **未闭合元素**：`finish()` 时仍在栈上的元素通过 `unclosed()` 返回 qname、解析路径与起始原始偏移；此前已完整闭合的 sibling 切片照常交付。

## 用法

```cpp
#include "xml_slicer.hpp"
using namespace dataeng::xml;

XmlSlicer slicer({
    .target_paths = {"/{urn:doc}catalog/record"},
    .entity_expansion_budget = 1ULL << 20,
});

while (auto chunk = next_network_chunk()) {
    if (!slicer.feed(chunk.data(), chunk.size())) {
        break;  // slicer.error() 给出码、消息、偏移
    }
}
slicer.finish();

for (Slice& s : slicer.take_slices()) {
    // s.raw：子树原始字节；s.start_offset/end_offset：相对流起点的偏移
    publish(s.path, s.raw, s.start_offset);
}
for (const UnclosedElement& u : slicer.unclosed()) {
    log_unclosed(u.qname, u.resolved_path, u.start_offset);
}
```

### 错误码

- `Malformed`：标签不闭合/不匹配、非法引用、非法注释或 `]]>` 等良构性错误。
- `ExternalEntity`：任何外部 DTD、外部实体或参数实体用法。
- `UndefinedEntity` / `EntityRecursion` / `EntityBudgetExceeded`：实体解析相关错误。
- `EncodingNotSupported`：XML 声明了非 UTF-8 编码。

出错后切片器进入终态，后续 `feed()` 直接返回 `false`，已产出的切片仍可通过 `take_slices()` 取走。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```
