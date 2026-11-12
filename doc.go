// Package dataeng 读取按块（chunk）存放的多维 int64 数组。
//
// 数组维数介于 1 到 8 之间，形状各维非负，块形状各维为正整数，形状与块
// 形状均按行主序（row-major）解释。块由调用方注入的 ChunkReader 按块坐标
// 读取；处于数组边界的块可以不足满块，其实际长度必须与该块各维实际边尺寸
// 的乘积一致，否则 Read 返回 ErrBadChunk。
//
// Read 对每维给出 start、count、非零 step 的查询，step 允许为负数；所有
// 被访问到的坐标都必须落在形状内。Read 先完成全部坐标与乘积溢出校验，然后
// 才会调用 ChunkReader。同一块在一次查询中最多被读取一次，返回值按查询索引
// 行主序排列，并通过 Result.Visits 汇报每块被实际访问到的全局坐标。
package dataeng
