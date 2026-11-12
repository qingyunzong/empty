package dataeng

import (
	"fmt"
	"sort"
)

type compiledColumn struct {
	table  TableID
	id     ColumnID
	domain []string
}

type compiledTable struct {
	id       TableID
	rows     int
	columns  []ColumnID
	colIndex map[ColumnID]int
}

type compiled struct {
	tables    map[TableID]*compiledTable
	tableIDs  []TableID
	columns   map[TableID]map[ColumnID]*compiledColumn
	positions []Position
	// posIndex 给出 (table,row,column) 在展平向量中的下标。
	posIndex map[TableID]map[ColumnID][]int
	// rowEnd[i] 为 true 时，位置 i 是其所在行的最后一个单元格。
	rowEnd []bool
	// rowStart[i] 为 true 时，位置 i 是其所在行的第一个单元格。
	rowStart []bool
}

// Validate 检查输入是否落在题目允许的结构与规模边界内。
func (s Spec) Validate() error {
	if len(s.Tables) == 0 {
		return fmt.Errorf("spec: 至少需要一张表")
	}
	if len(s.Tables) > MaxTables {
		return fmt.Errorf("spec: 表数量 %d 超过上限 %d", len(s.Tables), MaxTables)
	}
	tableSeen := map[TableID]bool{}
	totalCells := 0
	for _, t := range s.Tables {
		if t.ID == "" {
			return fmt.Errorf("spec: 表 ID 不能为空")
		}
		if tableSeen[t.ID] {
			return fmt.Errorf("spec: 表 ID 重复: %q", string(t.ID))
		}
		tableSeen[t.ID] = true
		if t.Rows < 0 {
			return fmt.Errorf("spec: 表 %q 行数不能为负", string(t.ID))
		}
		if len(t.Columns) == 0 {
			return fmt.Errorf("spec: 表 %q 至少需要一列", string(t.ID))
		}
		if len(t.Columns) > MaxColumnsPerTable {
			return fmt.Errorf("spec: 表 %q 列数 %d 超过上限 %d",
				string(t.ID), len(t.Columns), MaxColumnsPerTable)
		}
		colSeen := map[ColumnID]bool{}
		for _, c := range t.Columns {
			if c.ID == "" {
				return fmt.Errorf("spec: 表 %q 存在空列 ID", string(t.ID))
			}
			if colSeen[c.ID] {
				return fmt.Errorf("spec: 表 %q 列 ID 重复: %q",
					string(t.ID), string(c.ID))
			}
			colSeen[c.ID] = true
			if len(c.Domain) == 0 {
				return fmt.Errorf("spec: 表 %q 列 %q 的枚举域不能为空",
					string(t.ID), string(c.ID))
			}
			if len(c.Domain) > MaxDomainValues {
				return fmt.Errorf("spec: 表 %q 列 %q 枚举域大小 %d 超过上限 %d",
					string(t.ID), string(c.ID), len(c.Domain), MaxDomainValues)
			}
			valueSeen := map[string]bool{}
			for _, v := range c.Domain {
				if valueSeen[v] {
					return fmt.Errorf("spec: 表 %q 列 %q 枚举值重复: %q",
						string(t.ID), string(c.ID), v)
				}
				valueSeen[v] = true
			}
		}
		totalCells += t.Rows * len(t.Columns)
	}
	if totalCells > MaxTotalCells {
		return fmt.Errorf("spec: 总单元格数 %d 超过上限 %d", totalCells, MaxTotalCells)
	}
	return nil
}

// Validate 同时检查具名约束的结构合法性与命名唯一性。
func Validate(spec Spec, constraints []Constraint) error {
	if err := spec.Validate(); err != nil {
		return err
	}
	if len(constraints) == 0 {
		return nil
	}
	nameSeen := map[string]bool{}
	pkTables := map[TableID]string{}
	tableSet := map[TableID]map[ColumnID]bool{}
	for _, t := range spec.Tables {
		cols := map[ColumnID]bool{}
		for _, c := range t.Columns {
			cols[c.ID] = true
		}
		tableSet[t.ID] = cols
	}
	for _, c := range constraints {
		if c.Name == "" {
			return fmt.Errorf("constraints: 约束名不能为空")
		}
		if nameSeen[c.Name] {
			return fmt.Errorf("constraints: 约束名重复: %q", c.Name)
		}
		nameSeen[c.Name] = true
		cols, ok := tableSet[c.Table]
		if !ok {
			return fmt.Errorf("constraints: 约束 %q 引用了不存在的表 %q",
				c.Name, string(c.Table))
		}
		switch c.Kind {
		case KindNotNull:
			if !cols[c.Column] {
				return fmt.Errorf("constraints: 非空约束 %q 引用了不存在的列 %q.%q",
					c.Name, string(c.Table), string(c.Column))
			}
		case KindPrimaryKey:
			if len(c.Columns) == 0 {
				return fmt.Errorf("constraints: 主键约束 %q 至少需要一列", c.Name)
			}
			for _, col := range c.Columns {
				if !cols[col] {
					return fmt.Errorf("constraints: 主键约束 %q 引用了不存在的列 %q.%q",
						c.Name, string(c.Table), string(col))
				}
			}
			if prior, dup := pkTables[c.Table]; dup {
				return fmt.Errorf("constraints: 表 %q 存在两个主键约束 %q 与 %q",
					string(c.Table), prior, c.Name)
			}
			pkTables[c.Table] = c.Name
		case KindForeignKey:
			if !cols[c.Column] {
				return fmt.Errorf("constraints: 外键 %q 引用了不存在的源列 %q.%q",
					c.Name, string(c.Table), string(c.Column))
			}
			refCols, ok := tableSet[c.RefTable]
			if !ok {
				return fmt.Errorf("constraints: 外键 %q 引用了不存在的目标表 %q",
					c.Name, string(c.RefTable))
			}
			if !refCols[c.RefColumn] {
				return fmt.Errorf("constraints: 外键 %q 引用了不存在的目标列 %q.%q",
					c.Name, string(c.RefTable), string(c.RefColumn))
			}
		default:
			return fmt.Errorf("constraints: 约束 %q 的类型 %d 不支持", c.Name, c.Kind)
		}
	}
	return nil
}

func compile(spec Spec) *compiled {
	m := &compiled{
		tables:   map[TableID]*compiledTable{},
		columns:  map[TableID]map[ColumnID]*compiledColumn{},
		posIndex: map[TableID]map[ColumnID][]int{},
	}
	for _, t := range spec.Tables {
		m.tableIDs = append(m.tableIDs, t.ID)
	}
	sort.Slice(m.tableIDs, func(i, j int) bool { return m.tableIDs[i] < m.tableIDs[j] })

	for _, t := range spec.Tables {
		ct := &compiledTable{
			id:       t.ID,
			rows:     t.Rows,
			colIndex: map[ColumnID]int{},
		}
		m.columns[t.ID] = map[ColumnID]*compiledColumn{}
		m.posIndex[t.ID] = map[ColumnID][]int{}
		for _, c := range t.Columns {
			m.columns[t.ID][c.ID] = &compiledColumn{table: t.ID, id: c.ID, domain: c.Domain}
		}
		for _, c := range t.Columns {
			ct.columns = append(ct.columns, c.ID)
		}
		sort.Slice(ct.columns, func(i, j int) bool { return ct.columns[i] < ct.columns[j] })
		for i, col := range ct.columns {
			ct.colIndex[col] = i
		}
		m.tables[t.ID] = ct
	}

	for _, tableID := range m.tableIDs {
		ct := m.tables[tableID]
		for row := 0; row < ct.rows; row++ {
			for colOrd, col := range ct.columns {
				idx := len(m.positions)
				m.positions = append(m.positions, Position{Table: tableID, Row: row, Column: col})
				m.posIndex[tableID][col] = append(m.posIndex[tableID][col], idx)
				m.rowStart = append(m.rowStart, colOrd == 0)
				m.rowEnd = append(m.rowEnd, colOrd == len(ct.columns)-1)
			}
		}
	}
	return m
}

func (m *compiled) index(table TableID, row int, column ColumnID) int {
	return m.posIndex[table][column][row]
}
