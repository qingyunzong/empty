package dataeng

import (
	"sort"
	"strings"
)

type model struct {
	compiled *compiled
	notNull  map[TableID]map[ColumnID]bool
	pk       map[TableID][]ColumnID
	fks      []Constraint
}

func buildModel(spec Spec, constraints []Constraint) *model {
	m := &model{
		compiled: compile(spec),
		notNull:  map[TableID]map[ColumnID]bool{},
		pk:       map[TableID][]ColumnID{},
	}
	for _, t := range spec.Tables {
		m.notNull[t.ID] = map[ColumnID]bool{}
	}
	for _, c := range constraints {
		switch c.Kind {
		case KindNotNull:
			m.notNull[c.Table][c.Column] = true
		case KindPrimaryKey:
			m.pk[c.Table] = append([]ColumnID(nil), c.Columns...)
			for _, col := range c.Columns {
				m.notNull[c.Table][col] = true
			}
		case KindForeignKey:
			m.fks = append(m.fks, c)
		}
	}
	return m
}

// valueChoices 返回单个单元格按字典序排列的候选值：
// 域索引 0..k-1 在前，NULL（仅可空列）排在最后。
func valueChoices(m *model, table TableID, column ColumnID) []Cell {
	domain := m.compiled.columns[table][column].domain
	choices := make([]Cell, 0, len(domain)+1)
	for i := range domain {
		choices = append(choices, Cell(i))
	}
	if !m.notNull[table][column] {
		choices = append(choices, Null)
	}
	return choices
}

func (m *model) domainValue(table TableID, column ColumnID, cell Cell) string {
	return m.compiled.columns[table][column].domain[int(cell)]
}

// consistentFull 对完整赋值逐条核验全部已启用约束。
func (m *model) consistentFull(values []Cell) bool {
	for _, tableID := range m.compiled.tableIDs {
		ct := m.compiled.tables[tableID]
		for col := range m.notNull[tableID] {
			for row := 0; row < ct.rows; row++ {
				if values[m.compiled.index(tableID, row, col)] == Null {
					return false
				}
			}
		}
		if pkCols, ok := m.pk[tableID]; ok {
			seen := map[string]bool{}
			for row := 0; row < ct.rows; row++ {
				parts := make([]string, len(pkCols))
				for i, col := range pkCols {
					cell := values[m.compiled.index(tableID, row, col)]
					if cell == Null {
						return false
					}
					parts[i] = m.domainValue(tableID, col, cell)
				}
				key := strings.Join(parts, "\x00")
				if seen[key] {
					return false
				}
				seen[key] = true
			}
		}
	}
	for _, fk := range m.fks {
		refTable := m.compiled.tables[fk.RefTable]
		srcTable := m.compiled.tables[fk.Table]
		for row := 0; row < srcTable.rows; row++ {
			cell := values[m.compiled.index(fk.Table, row, fk.Column)]
			if cell == Null {
				continue
			}
			want := m.domainValue(fk.Table, fk.Column, cell)
			matched := false
			for refRow := 0; refRow < refTable.rows; refRow++ {
				refCell := values[m.compiled.index(fk.RefTable, refRow, fk.RefColumn)]
				if refCell == Null {
					continue
				}
				if m.domainValue(fk.RefTable, fk.RefColumn, refCell) == want {
					matched = true
					break
				}
			}
			if !matched {
				return false
			}
		}
	}
	return true
}

// rowComplete 判断某表某行的全部单元格是否已赋值（下标不超过 pos）。
func (m *model) rowComplete(pos int, table TableID, row int) bool {
	ct := m.compiled.tables[table]
	last := m.compiled.index(table, row, ct.columns[len(ct.columns)-1])
	return last <= pos
}

// consistentPrefix 是 DFS 中的增量剪枝：只依赖下标 <= pos 的已赋值单元格。
func (m *model) consistentPrefix(values []Cell, pos int) bool {
	p := m.compiled.positions[pos]
	if !m.compiled.rowEnd[pos] {
		return true
	}

	// 当前刚完成一行：核验该表主键（含隐式非空）与元组唯一性。
	if pkCols, ok := m.pk[p.Table]; ok {
		seen := map[string]bool{}
		for row := 0; row <= p.Row; row++ {
			parts := make([]string, len(pkCols))
			for i, col := range pkCols {
				cell := values[m.compiled.index(p.Table, row, col)]
				if cell == Null {
					return false
				}
				parts[i] = m.domainValue(p.Table, col, cell)
			}
			key := strings.Join(parts, "\x00")
			if seen[key] {
				return false
			}
			seen[key] = true
		}
	}

	// 核验所有“引用行已完整”的外键；被引用表尚未写完时留待后续，
	// 叶子节点的 consistentFull 会兜底。
	for _, fk := range m.fks {
		srcTable := m.compiled.tables[fk.Table]
		refTable := m.compiled.tables[fk.RefTable]
		for row := 0; row < srcTable.rows; row++ {
			if !m.rowComplete(pos, fk.Table, row) {
				continue
			}
			cell := values[m.compiled.index(fk.Table, row, fk.Column)]
			if cell == Null {
				continue
			}
			want := m.domainValue(fk.Table, fk.Column, cell)
			matched := false
			for refRow := 0; refRow < refTable.rows; refRow++ {
				if !m.rowComplete(pos, fk.RefTable, refRow) {
					continue
				}
				refCell := values[m.compiled.index(fk.RefTable, refRow, fk.RefColumn)]
				if refCell == Null {
					continue
				}
				if m.domainValue(fk.RefTable, fk.RefColumn, refCell) == want {
					matched = true
					break
				}
			}
			if !matched {
				// 被引用表为零行表，非空外键值永远无法匹配。
				if refTable.rows == 0 {
					return false
				}
				// 被引用表仍有未写行时不能判死，交给后续剪枝/全量校验。
				refLast := m.compiled.index(fk.RefTable, refTable.rows-1,
					refTable.columns[len(refTable.columns)-1])
				if refLast > pos {
					continue
				}
				return false
			}
		}
	}
	return true
}

// solve 返回启用给定约束时的字典序最小合法夹具；无解返回 nil, false。
func solve(spec Spec, constraints []Constraint) (*Fixture, bool) {
	m := buildModel(spec, constraints)

	n := len(m.compiled.positions)
	values := make([]Cell, n)

	var dfs func(pos int) bool
	dfs = func(pos int) bool {
		if pos == n {
			return m.consistentFull(values)
		}
		p := m.compiled.positions[pos]
		for _, cell := range valueChoices(m, p.Table, p.Column) {
			values[pos] = cell
			if m.consistentPrefix(values, pos) && dfs(pos+1) {
				return true
			}
		}
		return false
	}
	if !dfs(0) {
		return nil, false
	}

	out := &Fixture{
		Positions: append([]Position(nil), m.compiled.positions...),
		Values:    append([]Cell(nil), values...),
	}
	return out, true
}

func sortedConstraintNames(constraints []Constraint) []string {
	names := make([]string, 0, len(constraints))
	for _, c := range constraints {
		names = append(names, c.Name)
	}
	sort.Strings(names)
	return names
}
