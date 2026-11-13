# ORC ACID base/delta 合并

Hive ACID 读取层需要可嵌入的 C++ ORC base/delta 合并库，按 writeId range、statementId、bucketId 和 rowId 选择有效文件并应用 delete delta。compaction 覆盖旧 delta 但不越过读者 validWriteIdList；重复 row 版本取最高可见写入。
