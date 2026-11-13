# Sort-merge join 重复组跨块

批执行器需要可导入的 Go sort-merge join 状态库，两侧有序输入按块到达，重复键组可能跨块并大于内存。组件溢写单组并生成 inner/outer/semi/anti 结果；暂停恢复保持组游标，不能漏配笛卡尔组合或重复 unmatched。
