# filepatch

把两棵文件树之间的变化解释成**费用最小且可实际执行**的补丁，并附带可独立核验的最优性证书。纯 Python 3.11 标准库实现。

## 模型

- 文件描述：路径、类型（`"file"`）与内容行序列；目录由路径隐式表示。
- 支持操作：添加、删除、修改、重命名（含交换路径）。
- 费用（均为非负整数）：
  - 重命名候选费用 = 路径编辑距离（字符级 Levenshtein）+ 内容编辑距离（最短行编辑脚本长度）；
  - 添加 / 删除费用 = 内容字节数（每行 UTF-8 字节 + 换行）；
  - 修改费用 = 最短行编辑脚本长度（插入 + 删除行数）。

## 匹配与并列规则

跨路径配对由精确最小费用二分匹配（匈牙利算法）决定，**不**先贪心按同哈希配对。并列最优时按规范化操作序列（排序后的规范操作元组）字典序最小选择；该规则被编码为进位自由的大整数次目标，与主费用合并为单一权重求解。

## 可执行性

- 重命名环通过与任何输入路径都不冲突的临时名（`__filepatch_tmp_N__`）打破；
- 支持文件变目录 / 目录变文件等前缀冲突（必要时经临时名中转，保证正向与反向补丁都可执行）；
- 应用时先校验整树指纹与每个操作的源指纹，任一失败则整棵目标树不变（在副本上应用，失败即抛错）。

## 证书

补丁携带匹配的对偶势（`row_potentials` / `col_potentials`）。验证器确定性重建权重矩阵后仅检查：对偶可行性、匹配边紧性、原始-对偶总量相等、声明的代价与并列值一致——**不运行任何优化器**。

## CLI

```sh
python3.11 -m filepatch diff A.json B.json [--out patch.json]   # 计算补丁+证书
python3.11 -m filepatch apply TREE.json patch.json [--out T2.json]
python3.11 -m filepatch invert patch.json [--out rev.json]     # 反向补丁
python3.11 -m filepatch verify A.json B.json patch.json        # 核验证书
```

树 JSON 格式：`{"files": [{"path": "a/b", "type": "file", "lines": ["..."]}, ...]}`。

## 库 API

```python
from filepatch import Tree, build_patch, apply_patch, invert_patch, verify_patch

patch = build_patch(Tree({"a": ["1"]}), Tree({"b": ["1"]}))
verify_patch(source_tree, target_tree, patch)   # 证书核验
new_tree = apply_patch(source_tree, patch)      # 原子应用
reverse = invert_patch(patch)                   # 反向补丁
```

## 测试

```sh
python3.11 -m unittest discover -s tests -v
```

覆盖：≤7 文件全枚举核对最优费用与并列规则、三路径循环、同名内容变化但跨路径配对更优、重复内容、路径前缀冲突、证书篡改、补丁应用后反向还原原树、指纹失败原子性、CLI 端到端。
