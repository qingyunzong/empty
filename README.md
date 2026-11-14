# 分布漂移分桶对齐

`dataeng` 是一个只依赖 C++20 标准库的分布比较组件，适合直接
`add_subdirectory` 或以静态库形式嵌入监控服务。它接收两个桶边界不同
的数值直方图，以及各自的 null/NaN 计数，在边界并集上重分配质量，
输出总体与逐区间 PSI/JS 贡献，并显式记录无界桶带来的质量不确定性。

## 使用

```cpp
#include "dataeng.hpp"
#include <limits>

dataeng::Histogram p;
p.edges = {0.0, 10.0, 20.0, std::numeric_limits<double>::infinity()};
p.counts = {120.0, 80.0, 20.0};
p.null_count = 4.0;
p.nan_count = 2.0;

dataeng::Histogram q;
q.edges = {0.0, 5.0, 15.0, std::numeric_limits<double>::infinity()};
q.counts = {60.0, 100.0, 40.0};
q.null_count = 8.0;
q.nan_count = 0.0;

dataeng::Options options;
options.zero_floor = 1e-6;
options.missing = dataeng::MissingPolicy::IncludeAsCategories;

dataeng::ComparisonResult result = dataeng::try_compare(p, q, options);
if (!result.ok) {
    // 输入非法或策略拒绝时，result.error 给出原因。
}

double psi = result.psi;
double js = result.js;              // 自然对数
double js_bits = result.js_bits;    // log2

for (const auto& interval : result.intervals) {
    // interval.lower/upper 可为 -inf/+inf
    // p_mass/q_mass 为重分配后的质量
    // psi/js 为主指标贡献；numeric_psi/numeric_js 为纯数值部分贡献
}
```

`dataeng::try_compare(p, q, options)` 与 `compare` 参数相同，但不抛出
异常，失败时返回 `ok == false` 和 `error`。`DistributionComparator`
封装固定配置，可在线程间共享（比较本身不修改内部状态）。
`compare` 在输入非法或策略拒绝时抛出 `std::invalid_argument`，成功时
返回 `ok == true`。

## 重分配规则

1. 对两个直方图的所有边界取并集，形成有序的公共区间。相同边界只保留
   一次；输入边界必须严格递增，首尾之外不允许出现无穷值。
2. 有限桶 `[a,b)` 的质量按桶内均匀假设重分配：
   对公共区间与桶的交集，质量份额为 `交集宽度 / (b-a)`。若某个公共
   区间完整覆盖整个桶，则精度只受浮点舍入影响。
3. 无界桶不会被赋予一个虚构的均匀宽度：
   - 无界桶未被对端边界切分时，整个桶就是一个公共区间，质量原样保留，
     误差为 0。
   - 下无界桶 `(-inf,b]` 被切分时，默认
     `InfiniteBinPolicy::CollapseToBoundary` 把全部质量放在紧邻有限端点
     `b` 的内侧区间；上无界桶把质量放在紧邻下端点 `a` 的内侧区间。
   - 完全无界桶 `(-inf,+inf)` 没有有限端点可锚定；默认策略对它同样按
     公共区间数均分，并把它标记为高不确定性。
   - `InfiniteBinPolicy::SplitEvenly` 强制所有被切分的无界桶按公共区间
     数量均分。`Reject` 在接受无法均匀重分配的无界桶时直接失败。

有限桶在均匀桶内模型下是精确的。被切分的无界桶不能由输入唯一确定，
因此每个相关公共区间的 `p_mass_error_bound`/`q_mass_error_bound` 记录
父桶的全部质量，`p_unresolved_mass`/`q_unresolved_mass` 记录这些父桶
质量之和。`psi_error_bound`/`js_error_bound` 是由该质量不确定性和
零质量下限推导出的保守敏感度上界，不是采样置信区间；没有不可解析质量
时它们为 0。若使用 `ZeroMassPolicy::Reject` 且存在不可解析质量，
扰动可能产生零概率并使指标无定义，此时误差界为无穷大。

## PSI、JS 与零质量

PSI 使用自然对数：

`PSI = sum_i (p_i - q_i) * ln(p_i / q_i)`

JS 也使用自然对数：

`JS = 0.5 * sum_i [p_i ln(2p_i/(p_i+q_i)) + q_i ln(2q_i/(p_i+q_i))]`

JS 同时提供以 bit 为单位的 `js_bits`。计算前按如下规则处理零质量：

- 两个直方图在某个公共区间都为 0 时，该区间不参与归一化和指标计算，
  贡献为 0，且 `included == false`。
- 某侧在活跃区间上的概率低于 `zero_floor`（包括精确为 0）时，提升到
  `zero_floor`；随后 P、Q 各自重新归一化到和为 1。默认值为 `1e-6`。
  `p_smoothed`/`q_smoothed` 标记发生提升的侧。
- 若某一侧整体没有质量，而另一侧有质量，所有活跃类别先变为
  `zero_floor`，再归一化，因此该侧退化为均匀分布。两侧都为空时指标
  定义为 0，`primary_defined == false`。
- `ZeroMassPolicy::Reject` 在出现单侧零质量的活跃区间时返回错误，而
  不是产生无穷大。

`zero_floor` 必须是 `(0,1)` 内的有限值。

## null/NaN

null 与 NaN 不计入数值桶的重分配。它们始终以计数和占比输出：
`p_null_fraction = p_null / (数值质量 + null + NaN)`，NaN 同理。

- `MissingPolicy::IncludeAsCategories`（默认）：null、NaN 分别作为独立
  类别进入主指标，分母包含数值、null 和 NaN。缺失类别也遵守上述平滑
  规则，`result.null_contribution`/`result.nan_contribution` 给出贡献。
- `MissingPolicy::Exclude`：主指标 `psi`/`js` 只比较数值部分，分母为
  数值质量；缺失类别仍单独计算，结果在 `missing_psi`/`missing_js` 与
  两个 `MissingContribution` 的 `missing_*` 字段中。

`result.numeric_psi`/`numeric_js` 始终表示纯数值直方图的比较结果，
`result.intervals[i].numeric_*` 是对应的逐区间贡献。主指标与数值指标的
概率分别归一化，因此当缺失类别进入主指标时，两组概率不会相同。

## 输出约定

- 质量为权重，可为非整数；所有计数必须有限且非负。
- `intervals` 按边界升序排列，覆盖并集的外边界；可能包含零质量区间。
- `p_mass`/`q_mass` 是重分配后的数值质量，满足各直方图质量守恒。
- `p_probability`/`q_probability`、`psi`、`js` 属于主指标。
- `numeric_p_probability`/`numeric_q_probability`、`numeric_psi`、
  `numeric_js` 属于纯数值指标。
- 浮点比较使用 `double` 输出，内部重分配与求和使用 `long double`。
- 复杂度为 `O((n+m) log(n+m))`，额外内存为 `O(n+m)`。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```
