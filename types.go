package dataeng

import "strconv"

// 输入规模上限：约束求解与全枚举核验都在该边界内工作。
const (
	MaxTables          = 5
	MaxColumnsPerTable = 4
	MaxDomainValues    = 4
	MaxTotalCells      = 20
)

type TableID string
type ColumnID string

// Column 描述一列及其有限枚举域，Domain 长度须在 1..MaxDomainValues 之间。
type Column struct {
	ID     ColumnID
	Domain []string
}

// Table 描述一张表；Rows 是该表要求的固定行数，允许为 0。
type Table struct {
	ID      TableID
	Rows    int
	Columns []Column
}

// Spec 是夹具生成输入：至多 MaxTables 张表，总单元格数至多 MaxTotalCells。
type Spec struct {
	Tables []Table
}

// Kind 枚举允许的三类具名约束：非空、主键唯一、单列外键。
type Kind int

const (
	KindNotNull Kind = iota + 1
	KindPrimaryKey
	KindForeignKey
)

// Constraint 是具名约束。不同 Kind 使用不同字段：
//   - KindNotNull:      Table / Column
//   - KindPrimaryKey:   Table / Columns（复合主键，隐式要求成员列非空）
//   - KindForeignKey:   Table / Column -> RefTable / RefColumn（单列外键，
//     NULL 外键值按 SQL 语义放行，允许自引用与表间循环）
type Constraint struct {
	Name      string
	Kind      Kind
	Table     TableID
	Column    ColumnID
	Columns   []ColumnID
	RefTable  TableID
	RefColumn ColumnID
}

// NotNull 构造列级非空约束。
func NotNull(name string, table TableID, column ColumnID) Constraint {
	return Constraint{Name: name, Kind: KindNotNull, Table: table, Column: column}
}

// PrimaryKey 构造主键约束，columns 为一个或多个成员列（复合主键）。
// 主键约束同时蕴含成员列非空与元组跨行唯一。
func PrimaryKey(name string, table TableID, columns ...ColumnID) Constraint {
	return Constraint{
		Name:    name,
		Kind:    KindPrimaryKey,
		Table:   table,
		Columns: append([]ColumnID(nil), columns...),
	}
}

// ForeignKey 构造单列外键约束：table.column 的每个非空值必须出现在
// refTable.refColumn 的非空单元格中。允许指向自身或形成引用环。
func ForeignKey(name string, table TableID, column ColumnID, refTable TableID, refColumn ColumnID) Constraint {
	return Constraint{
		Name:      name,
		Kind:      KindForeignKey,
		Table:     table,
		Column:    column,
		RefTable:  refTable,
		RefColumn: refColumn,
	}
}

// Cell 是扁平化夹具向量中的一个元素：列枚举域的 0 基索引；
// Null 表示该单元格为 SQL NULL，字典序上排在所有域索引之后。
type Cell int

const Null Cell = -1

func (c Cell) String() string {
	if c == Null {
		return "<null>"
	}
	return strconv.Itoa(int(c))
}

// Position 标识扁平化向量中一个单元格的坐标。
type Position struct {
	Table  TableID
	Row    int
	Column ColumnID
}

// Fixture 是按（表 ID 字典序、行位置、列 ID 字典序）展平的夹具：
// Positions[i] 与 Values[i] 一一对应，Values 即值域索引向量。
type Fixture struct {
	Positions []Position
	Values    []Cell
}

// ValueAt 返回指定坐标的域索引；坐标不存在时 ok 为 false。
func (f *Fixture) ValueAt(table TableID, row int, column ColumnID) (cell Cell, ok bool) {
	for i, p := range f.Positions {
		if p.Table == table && p.Row == row && p.Column == column {
			return f.Values[i], true
		}
	}
	return 0, false
}

// EnumValueAt 返回指定坐标的实际枚举字符串；isNull 为 true 时 value 无意义。
func (f *Fixture) EnumValueAt(spec Spec, table TableID, row int, column ColumnID) (value string, isNull bool, ok bool) {
	cell, found := f.ValueAt(table, row, column)
	if !found {
		return "", false, false
	}
	if cell == Null {
		return "", true, true
	}
	for _, t := range spec.Tables {
		if t.ID != table {
			continue
		}
		for _, c := range t.Columns {
			if c.ID != column {
				continue
			}
			if cell < 0 || int(cell) >= len(c.Domain) {
				return "", false, false
			}
			return c.Domain[int(cell)], false, true
		}
	}
	return "", false, false
}

// Result 是 Solve 的结果：可满足时 Fixture 非空；不可满足时 Unsat 非空。
type Result struct {
	Satisfiable bool
	Fixture     *Fixture
	Unsat       *UnsatReport
}

// UnsatReport 描述不可满足输入：
//   - MUS: 具名约束的最小不可满足子集（子集极小，按名排序）；
//   - Certificates: 对 MUS 中每个约束 c，给出删除 c 后的字典序最小夹具；
//   - CertificateScopes: 每份证书实际启用的约束名集合（优先使用“全集删除 c”，
//     若其仍不可满足则退化为“MUS 删除 c”，并在此字段如实记录）。
type UnsatReport struct {
	MUS               []string
	Certificates      map[string]*Fixture
	CertificateScopes map[string][]string
}
