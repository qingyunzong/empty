# 几何有效性修复血缘

`dataeng` 是一个可直接嵌入空间 ETL 的 C++20 多边形校验/修复组件。它不只
输出修复后的图形，而是同时返回：

- 输入环的校验诊断（自交、重复环、错误方向、洞越界、洞重叠等）；
- 按显式 `RepairPolicy` 生成的候选修复；
- 每个输出环到输入边区间的血缘；
- 修复前后的面积、变化量和阈值判定结果；
- 修复后仍存在的诊断，以及候选被拒绝的原因。

小整数坐标会保留精确的 `int64` 表示，方向、在线段上、线段相交和面积计算
使用 128 位整数内核，不受浮点舍入影响。

## 构建

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

## 快速接入

```cpp
#include "dataeng.hpp"

using namespace dataeng;

Polygon polygon;
polygon.shell = Ring{{Point::integer(0, 0), Point::integer(10, 0),
                      Point::integer(10, 10), Point::integer(0, 10)}};
polygon.holes.push_back(
    Ring{{Point::integer(2, 2), Point::integer(2, 8),
          Point::integer(8, 8), Point::integer(8, 2)}});

ValidationReport check = validate(polygon);
if (!check.valid()) {
  RepairPolicy policy;             // 明确策略，见下节
  AreaThreshold limit;
  limit.max_absolute_delta = 0.5;  // 面积变化超过 0.5 的候选会被拒绝
  RepairReport report = repair(polygon, policy, limit);
  if (const RepairCandidate* best = report.best()) {
    // best->polygons 是修复结果，best->area / remaining_issues / actions
    // 给出接受该候选的完整依据。
  }
}
```

`PolygonValidityEngine` 提供同一套校验器和策略修复器，便于 ETL stage 持有。

## 坐标与精确谓词

- `Point::integer(x, y)` 显式使用精确整数坐标；`Point(x, y)` 在值可无损放入
  `int64` 时也会自动启用精确路径。
- `Point::real(x, y)` 强制使用浮点坐标；所有谓词退化为 `long double`。
- 方向（`orientation`）、点在线段上、线段相交、环面积均在整数路径上使用
  `__int128` 中间结果。适合乘积可放入有符号 128 位的“小整数”坐标（例如
  `|coord| <= 2^61` 的量级）。
- 非整数坐标的修复交点使用 `long double` 表示；拓扑判定仍尽可能使用精确
  分支。

## 校验规则

环编号约定：`0` 是外环，`1..N` 依次对应 `Polygon::holes`。

| 问题 | `IssueKind` | 判定 |
| --- | --- | --- |
| 非法坐标 | `InvalidCoordinate` | 非有限坐标 |
| 退化环 | `DegenerateRing` | 少于 3 点或带符号面积为 0 |
| 重复顶点 | `RepeatedVertex` | 相邻顶点相同（包括闭合点） |
| 重复环 | `DuplicateRing` | 忽略起点和方向的同一环 |
| 错误方向 | `WrongOrientation` | 外环不是逆时针，或洞不是顺时针 |
| 自交 | `SelfIntersection` | 同环非相邻边交叉/共线重叠；相邻边回折 |
| 自接触 | `RingSelfTouch` | 非相邻边仅端点接触；默认警告 |
| 洞越界 | `HoleOutsideShell` | 洞完全在外、穿过或覆盖外环 |
| 洞重叠 | `HoleOverlap` | 两洞边界交叉或重叠 |
| 洞嵌套 | `HoleNesting` | 一个洞位于另一个洞内部 |
| 边界接触 | `RingTouch` | 洞-外环、洞-洞、组件间的有限点接触 |
| 组件越界 | `ComponentIntersection` / `ComponentContainment` | 多组件边界相交或包含 |

方向约定为 OGC/GeoJSON 常用约定：外环逆时针（正面积），洞顺时针（负面积）。
接触默认只产生 `Warning`；`ValidationOptions::strict_touching = true` 时
升级为错误。

## 修复策略

`RepairPolicy` 的每一项都是显式的：

- `duplicate_rings = Drop | Reject`：删除后出现的重复洞（或与外环重复的洞），
  或保留并让候选校验失败。
- `invalid_holes = Drop | Reject`：删除越界、交叉、重叠或嵌套的洞，或保留并
  让候选校验失败。
- `self_intersections = Split | Reject`：在真交叉点处切分自交环为简单环，或
  不生成切分候选。

生成器按“侵略性从低到高”产生候选，`RepairReport::best()` 返回第一个同时
通过几何校验和面积阈值的候选。`generate_staged_candidates = false` 时只
生成策略组合候选。所有候选都会带 `remaining_issues`；未通过的候选也会保留，
便于 ETL 记录“为何不可修复”。

自交切分目前处理两条非相邻边的真交叉，并递归切分，直到环简单或只剩非交叉
接触。共线重叠和端点接触不会被强行改写；它们会作为剩余诊断让候选被拒绝，
避免生成不可信几何。

## 输出环血缘

每个 `OutputRing` 有两层血缘：

- `edge_sources[i]`：输出边 `i` 对应的输入边及参数区间。切分点会让参数区间
  变成子区间（`t_begin`/`t_end`），反向遍历时参数递减。
- `source_spans`：合并后的环级输入边区间，适合写入 ETL 血缘表。

`SourceSpan::input_ring` 使用上面的全局环编号；`first_edge`/`last_edge` 是
输入环的边区间（按环遍历方向，可跨 `n-1 -> 0`），`edge_count` 是该区间内
实际参与的输入边数量。这样可区分“反向完整环”和“单边区间”。

## 面积阈值

`AreaThreshold` 同时支持绝对和相对变化；启用的限制必须全部通过：

```cpp
AreaThreshold limit;
limit.check_absolute = true;
limit.max_absolute_delta = 1e-6;
limit.check_relative = true;
limit.max_relative_delta = 1e-9;
```

默认只允许面积完全不变（绝对阈值 0）的修复，因此“删掉一个越界大洞”这类
候选默认会被拒绝，除非显式放宽阈值。`AreaCheck` 记录 `before`、`after`、
`absolute_delta`、`relative_delta`、`within_threshold` 和拒绝原因。

## 复杂度与边界

- 单环自交检测和环间检测为 O(n²)；适合 ETL 中逐要素/分块处理。
- 自交切分为递归实现，建议对超大环先分块或限制顶点数。
- 非整数坐标使用 `long double`，极小夹角/超近距离场景建议先量化为整数。
