# Paimon bucket rescale 路由

表写入器需要可导入的 TypeScript bucket rescale 状态库，维护旧新 bucket 映射、key ownership 和迁移水位。迁移中读取同时查询必要桶并去重，写入只进入当前 owner；checkpoint 完成后原子提升 epoch。迟到旧 epoch 写入明确拒绝。
