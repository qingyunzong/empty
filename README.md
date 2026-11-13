# CDC 主键更新成对归并

数据库 CDC 入口要嵌入可导入的 Go 主键变更归并库，依据事务、表 schema 世代和 before/after image 将 delete+insert 识别为一次键迁移。跨事务或证据不足不得猜测；目标键已存在时按唯一约束拒绝整事务。恢复重放保持相同迁移 id。
