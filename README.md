# Unicode collation 排序键世代

查询引擎需要可嵌入的 C++ collation key 组件，按 locale、strength、normalization 和 ICU 数据版本生成排序键。旧键只在相同配置世代比较；升级时后台重建并原子切换。等价字符串稳定成组，二级稳定键保证全序和分页可重复。
