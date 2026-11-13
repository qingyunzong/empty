# 嵌套 schema 兼容矩阵

数据契约服务需要可导入的 Go 嵌套 schema 比较库，覆盖 required/optional、list element、map key/value、decimal precision/scale 和字段 id。分别判定 reader 对 writer 的兼容方向，返回首个及全部破坏路径；字段顺序变化不影响结果，id 重用始终拒绝。
