# 关系夹具生成的键约束可满足性

包 `dataeng`（module `example.org/dataeng/q0172`）为采集接入测试生成满足
主键与单列外键约束的最小关系夹具，可直接被 Go 测试宿主导入。

## 输入边界

- 至多 5 张表（`MaxTables`），每表至多 4 列（`MaxColumnsPerTable`）。
- 每列带有限枚举域，域大小 1..4（`MaxDomainValues`）；总单元格数至多 20
  （`MaxTotalCells`），每表携带要求的固定行数，允许 0 行表。
- 约束仅三类且必须具名：`NotNull`（非空）、`PrimaryKey`（单列/复合主键，
  蕴含成员列非空与元组跨行唯一）、`ForeignKey`（单列外键）。
- 外键按 SQL 语义处理：NULL 外键值放行；允许自引用和表间引用环；被引用
  列为空表时，仅 NULL 外键可满足。
- 超出边界或引用不存在表/列、重名约束等由 `Validate` 拒绝。

## 排序与取值约定

- 夹具展平顺序：表 ID 字典序 → 行位置 0..n-1 → 列 ID 字典序，
  见 `Fixture.Positions` 与 `Fixture.Values`。
- 单格候选值顺序：域索引 `0..k-1` 升序，可空列的 `Null`（值为 -1）排在
  所有域索引之后。
- `Solve` 用按该顺序的深度优先搜索 + 增量约束剪枝，返回字典序最小的合法
  夹具（`Result.Fixture`）。

## 不可满足输出

输入无解时 `Result.Satisfiable=false`，`Result.Unsat` 给出：

- `MUS`：具名约束的最小不可满足子集（删除法求子集极小集合，按名排序）。
- `Certificates`：删除 MUS 中每个约束后的字典序最小夹具。
- `CertificateScopes`：每份证书实际启用的约束集合。优先使用“全约束删除
  该约束”；若其仍不可满足（存在独立冲突），退化为“MUS 删除该约束”，
  并在该字段如实记录。

## 全枚举核验

- `Enumerate` 按相同字典序穷举全部合法夹具，带节点预算（超出返回
  `ErrEnumerationLimit`），供测试做独立交叉核验。
- `IsValid` 对任意夹具做完整约束核验；`LessCells`/`LessFixture` 暴露
  字典序比较。
- 测试覆盖循环外键、自引用外键、空表引用（可空/非空）、复合主键及其
  容量耗尽、显式不可满足循环、边界校验，并以固定随机种子生成 60 组小
  规格，将求解器结果与全枚举首解逐单元格比对、对 MUS 极小性与证书逐一枚举。

## 运行

```bash
go vet ./...
go test ./... -v
```
