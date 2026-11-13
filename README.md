# 数据文件 checksum 逐层证明

数据传输层需要可嵌入的 C++ 分层校验组件，为 chunk、file、manifest 计算摘要树。断点续传只复用已验证 chunk；manifest 提交前验证根摘要和长度。算法迁移期间不同摘要世代不能混树，损坏返回最小失败子树。
