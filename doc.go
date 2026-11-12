// Package dataeng 生成满足主键与单列外键约束的最小关系夹具。
//
// 输入边界：至多 MaxTables 张表、每表至多 MaxColumnsPerTable 列、每个枚举域
// 至多 MaxDomainValues 个值、总单元格数至多 MaxTotalCells；每表携带要求的
// 固定行数（允许 0 行）。约束仅三类，均具名：
//
//   - NotNull：列非空；
//   - PrimaryKey：单列或复合主键，蕴含成员列非空与元组跨行唯一；
//   - ForeignKey：单列外键，NULL 值按 SQL 语义放行，允许自引用与引用环。
//
// 夹具按（表 ID 字典序、行位置、列 ID 字典序）展平为值域索引向量；每格按
// 域索引 0..k-1 升序取值，可空列的 NULL（Cell 取值 Null）排在所有域索引
// 之后。Solve 返回该顺序下字典序最小的合法夹具；不可满足时返回具名约束的
// 最小不可满足子集（MUS）以及删除其中任一约束后的字典序最小夹具证书。
//
// Enumerate 与 IsValid 提供全枚举核验能力，供测试宿主机交叉验证求解结果、
// MUS 的子集极小性与证书合法性。
package dataeng
