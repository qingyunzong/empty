package dataeng

import "errors"

// ErrEnumerationLimit 表示全枚举展开节点数超过调用方给定的预算。
var ErrEnumerationLimit = errors.New("dataeng: 全枚举节点数超过预算")

// IsValid 用与求解器相同的完整约束语义核验给定夹具。
func IsValid(spec Spec, constraints []Constraint, fixture *Fixture) (bool, error) {
	if err := Validate(spec, constraints); err != nil {
		return false, err
	}
	if fixture == nil {
		return false, errors.New("dataeng: 夹具为 nil")
	}
	m := buildModel(spec, constraints)
	if len(fixture.Values) != len(m.compiled.positions) ||
		len(fixture.Positions) != len(m.compiled.positions) {
		return false, errors.New("dataeng: 夹具向量长度与规格不符")
	}
	values := make([]Cell, len(fixture.Values))
	for i, pos := range fixture.Positions {
		ct := m.compiled.tables[pos.Table]
		if ct == nil || pos.Row < 0 || pos.Row >= ct.rows ||
			m.compiled.columns[pos.Table][pos.Column] == nil {
			return false, nil
		}
		values[m.compiled.index(pos.Table, pos.Row, pos.Column)] = fixture.Values[i]
		cell := fixture.Values[i]
		if cell != Null && (cell < 0 || int(cell) >= len(m.compiled.columns[pos.Table][pos.Column].domain)) {
			return false, nil
		}
	}
	return m.consistentFull(values), nil
}

// LessCells 按夹具约定的字典序比较单元格：域索引按数值升序，NULL 最大。
func LessCells(a, b Cell) bool {
	if a == Null {
		return false
	}
	if b == Null {
		return true
	}
	return a < b
}

// LessFixture 逐坐标比较两个夹具的值域索引向量。
func LessFixture(a, b *Fixture) bool {
	for i := range a.Values {
		if a.Values[i] == b.Values[i] {
			continue
		}
		return LessCells(a.Values[i], b.Values[i])
	}
	return false
}

// Enumerate 对全部合法夹具做穷举：按字典序依次回调。
// maxNodes 为展开的赋值节点预算（含内部节点），超出预算返回 ErrEnumerationLimit。
// 该函数用于测试中的全枚举核验，生产规模（<=20 单元格）下应配合小规格使用。
func Enumerate(spec Spec, constraints []Constraint, maxNodes int, visit func(*Fixture) bool) error {
	if err := Validate(spec, constraints); err != nil {
		return err
	}
	m := buildModel(spec, constraints)
	n := len(m.compiled.positions)
	values := make([]Cell, n)
	nodes := 0

	var dfs func(pos int) (done bool, err error)
	dfs = func(pos int) (bool, error) {
		nodes++
		if nodes > maxNodes {
			return false, ErrEnumerationLimit
		}
		if pos == n {
			if !m.consistentFull(values) {
				return false, nil
			}
			fixture := &Fixture{
				Positions: append([]Position(nil), m.compiled.positions...),
				Values:    append([]Cell(nil), values...),
			}
			return visit(fixture), nil
		}
		p := m.compiled.positions[pos]
		for _, cell := range valueChoices(m, p.Table, p.Column) {
			values[pos] = cell
			if !m.consistentPrefix(values, pos) {
				continue
			}
			done, err := dfs(pos + 1)
			if err != nil {
				return false, err
			}
			if done {
				return true, nil
			}
		}
		return false, nil
	}
	_, err := dfs(0)
	return err
}
