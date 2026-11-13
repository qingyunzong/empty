# Delta Lake checkpoint 补链

元数据服务需要可导入的 TypeScript Delta log 重建组件，从 multipart checkpoint 与后续 JSON actions 恢复指定版本。所有 checkpoint part 齐全且版本连续才可采用；add/remove 的 deletionVector、dataChange 与 txn 幂等语义分别处理。缺版本时返回精确区间，不静默跳过。
