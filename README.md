# 采集模式的稳定字段编号

数据接入服务需要Go模式合并包。decimal的p与s为整数且1<=p、0<=s<=p，输入模式若违反这些条件或自身精度超过上限也拒绝。模式是树，节点按稳定正整数ID识别，含名称、可空性及类型；类型可为int64、decimal(p,s)、string、struct或list，list恰有一个元素节点，struct的直接孩子名称不得重复，整棵树ID唯一。合并两个模式时同ID必须在同一父ID下，名称取新模式名称；缺失节点保留且转可空，新节点也转可空。int64可提升为decimal(19,0)，两个decimal取最大scale及最大整数位数，超过调用方精度上限拒绝；不同容器或其他类型变化拒绝。孩子先按旧序保留，再按新序附加新增节点；重命名造成重名、父节点迁移或根ID不同均失败且不改变输入。返回统一模式及从两份输入到统一模式的按ID映射计划。测试重命名、嵌套新增、相同名称不同ID和精度提升。

## API

- `Validate(s *Schema, maxPrecision int) error`：校验树结构、ID/名称不变量及 decimal 精度；错误包装 `ErrInvalidSchema`。
- `Merge(old, new *Schema, maxPrecision int) (*Schema, *Plan, error)`：合并两个模式版本，返回统一模式与按 ID 的映射计划；失败时错误包装 `ErrInvalidSchema` 或 `ErrIncompatible`，且返回值为 nil，输入不被修改。
- `Plan` 含 `OldIDToUnified`、`NewIDToUnified` 两张映射表；节点 ID 稳定，映射均为恒等映射，但表中枚举了完整字段对应关系。

## 合并语义

- 同 ID 节点必须挂在同一父 ID 下，根 ID 必须一致；名称采用新模式中的名称。
- 缺失节点与新增节点都保留在统一树中并强制可空（仅新增/缺失子树的根节点强制可空，后代保持自身可空性）；两边都存在的节点取两者可空性的并集。
- `int64` 与 `decimal` 合并时按 `decimal(19,0)` 提升；两个 decimal 的 scale 取最大值，整数位数取最大值，合成精度超过 `maxPrecision` 即拒绝。
- struct 孩子先按旧序输出，再按新序追加旧模式没有的节点；list 必须恰有一个元素且元素 ID 一致；容器类型或其余类型变化直接拒绝。
- 重命名导致 struct 下出现重名孩子时合并失败。
