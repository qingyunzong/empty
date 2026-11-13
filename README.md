# Iceberg 分区 spec 演进投影

查询规划器要接入可导入的 TypeScript Iceberg 分区投影库，把源列谓词分别投影到 identity、bucket、truncate、year/month/day/hour 的各 spec。无法精确投影时返回包容谓词，绝不误删；时区和负数 truncate 按规范执行，并给出残余谓词。
