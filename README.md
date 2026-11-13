# Excel 合并单元格表头展开

表格导入器要可直接接入 TypeScript 工作表结构解析组件，从二维单元格、merged ranges、hidden rows/columns 和公式缓存构造多级表头。合并区域重叠视为错误，空表头继承仅限其合并范围；数据行映射保留原坐标，重复列名用完整路径区分。
