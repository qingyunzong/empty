# Delta Lake optimistic commit 冲突

写入服务需要可导入的 TypeScript Delta 提交冲突检测库，比较 read predicates、read files、add/remove、metadata 和 protocol action。盲 append、分区覆盖与 MERGE 使用不同冲突规则；重试基于新版本重算，不能简单改版本号复用旧决定。
