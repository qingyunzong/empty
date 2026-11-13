# Oracle SCN 跨线程排序

日志挖掘入口需要可嵌入 C++ 事务排序组件，合并多个 redo thread 的 SCN、subSCN、事务 id 与 commit 标记。行变化先缓冲到事务，提交顺序相同则用公开并列键；thread reset 开启新世代。回滚和补偿记录必须撤销正确版本，水位不得越过未决事务。
