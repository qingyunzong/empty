package dataeng

import "testing"

func valuesFor(t *testing.T, f *Fixture, table TableID, rows int, cols []ColumnID) [][]Cell {
	t.Helper()
	out := make([][]Cell, rows)
	for r := 0; r < rows; r++ {
		for _, c := range cols {
			cell, ok := f.ValueAt(table, r, c)
			if !ok {
				t.Fatalf("缺少单元格 %q[%d].%q", string(table), r, string(c))
			}
			out[r] = append(out[r], cell)
		}
	}
	return out
}

// 循环外键：a.b -> b.a 且 b.a -> a.b，两列非空，只能取公共域同一值。
func TestSolveCyclicForeignKeys(t *testing.T) {
	spec := Spec{Tables: []Table{
		{ID: "a", Rows: 1, Columns: []Column{
			{ID: "b", Domain: []string{"x", "y"}},
		}},
		{ID: "b", Rows: 1, Columns: []Column{
			{ID: "a", Domain: []string{"x", "y"}},
		}},
	}}
	constraints := []Constraint{
		NotNull("nn_a_b", "a", "b"),
		NotNull("nn_b_a", "b", "a"),
		ForeignKey("fk_a_b", "a", "b", "b", "a"),
		ForeignKey("fk_b_a", "b", "a", "a", "b"),
	}
	result, err := Solve(spec, constraints)
	if err != nil {
		t.Fatalf("Solve 返回错误: %v", err)
	}
	if !result.Satisfiable {
		t.Fatalf("循环外键场景应可满足，实际 MUS=%v", result.Unsat.MUS)
	}
	got := valuesFor(t, result.Fixture, "a", 1, []ColumnID{"b"})
	if got[0][0] != 0 {
		t.Fatalf("字典序最小解应为域索引 0，实际为 %v", got)
	}
	if ok, err := IsValid(spec, constraints, result.Fixture); err != nil || !ok {
		t.Fatalf("IsValid = %v, %v", ok, err)
	}
	assertLexMinimumByEnumeration(t, spec, constraints, result.Fixture, 50000)
}

// 自引用外键（长度为 1 的环）：非空时父行必须先提供该值。
func TestSolveSelfReferencingForeignKey(t *testing.T) {
	spec := Spec{Tables: []Table{
		{ID: "node", Rows: 2, Columns: []Column{
			{ID: "id", Domain: []string{"p", "q", "r"}},
			{ID: "parent", Domain: []string{"p", "q", "r"}},
		}},
	}}
	constraints := []Constraint{
		PrimaryKey("pk_node", "node", "id"),
		NotNull("nn_node_parent", "node", "parent"),
		ForeignKey("fk_node_parent", "node", "parent", "node", "id"),
	}
	result, err := Solve(spec, constraints)
	if err != nil {
		t.Fatalf("Solve 返回错误: %v", err)
	}
	if !result.Satisfiable {
		t.Fatalf("自引用场景应可满足，实际 MUS=%v", result.Unsat.MUS)
	}
	got := valuesFor(t, result.Fixture, "node", 2, []ColumnID{"id", "parent"})
	want := [][]Cell{{0, 0}, {1, 0}}
	for r := range want {
		for c := range want[r] {
			if got[r][c] != want[r][c] {
				t.Fatalf("字典序最小解应为 %v，实际为 %v", want, got)
			}
		}
	}
	assertLexMinimumByEnumeration(t, spec, constraints, result.Fixture, 2_000_000)
}

// 空表引用：被引用表零行时，非空外键无解；允许 NULL 的外键以全 NULL 为最小解。
func TestSolveEmptyTableReference(t *testing.T) {
	spec := Spec{Tables: []Table{
		{ID: "child", Rows: 1, Columns: []Column{
			{ID: "ref", Domain: []string{"u", "v"}},
		}},
		{ID: "empty", Rows: 0, Columns: []Column{
			{ID: "code", Domain: []string{"u", "v"}},
		}},
	}}
	fk := ForeignKey("fk_child_ref", "child", "ref", "empty", "code")

	t.Run("nullable", func(t *testing.T) {
		result, err := Solve(spec, []Constraint{fk})
		if err != nil {
			t.Fatalf("Solve 返回错误: %v", err)
		}
		if !result.Satisfiable {
			t.Fatalf("可空外键引用空表应可满足，实际 MUS=%v", result.Unsat.MUS)
		}
		cell, _ := result.Fixture.ValueAt("child", 0, "ref")
		if cell != Null {
			t.Fatalf("字典序最小解应为 NULL（域索引均无法引用），实际为 %v", cell)
		}
		assertLexMinimumByEnumeration(t, spec, []Constraint{fk}, result.Fixture, 1000)
	})

	t.Run("not_null_unsat", func(t *testing.T) {
		constraints := []Constraint{fk, NotNull("nn_child_ref", "child", "ref")}
		result, err := Solve(spec, constraints)
		if err != nil {
			t.Fatalf("Solve 返回错误: %v", err)
		}
		if result.Satisfiable {
			t.Fatalf("非空外键引用空表应不可满足")
		}
		report := result.Unsat
		wantMUS := map[string]bool{"fk_child_ref": true, "nn_child_ref": true}
		if len(report.MUS) != 2 || !wantMUS[report.MUS[0]] || !wantMUS[report.MUS[1]] {
			t.Fatalf("MUS 应为两个约束，实际为 %v", report.MUS)
		}
		assertMUSByEnumeration(t, spec, constraints, report)
	})
}

// 复合主键：成员列隐式非空，两行列组必须互不相同。
func TestSolveCompositePrimaryKey(t *testing.T) {
	spec := Spec{Tables: []Table{
		{ID: "pair", Rows: 2, Columns: []Column{
			{ID: "k1", Domain: []string{"a", "b"}},
			{ID: "k2", Domain: []string{"0", "1"}},
		}},
	}}
	constraints := []Constraint{PrimaryKey("pk_pair", "pair", "k1", "k2")}
	result, err := Solve(spec, constraints)
	if err != nil {
		t.Fatalf("Solve 返回错误: %v", err)
	}
	if !result.Satisfiable {
		t.Fatalf("复合主键场景应可满足，实际 MUS=%v", result.Unsat.MUS)
	}
	got := valuesFor(t, result.Fixture, "pair", 2, []ColumnID{"k1", "k2"})
	want := [][]Cell{{0, 0}, {0, 1}}
	for r := range want {
		for c := range want[r] {
			if got[r][c] != want[r][c] {
				t.Fatalf("字典序最小复合主键解应为 %v，实际为 %v", want, got)
			}
		}
	}
	assertLexMinimumByEnumeration(t, spec, constraints, result.Fixture, 100000)
}

// 复合主键容量耗尽：域组合数少于要求行数，主键约束单独构成 MUS。
func TestSolveCompositePrimaryKeyExhausted(t *testing.T) {
	spec := Spec{Tables: []Table{
		{ID: "pair", Rows: 3, Columns: []Column{
			{ID: "k1", Domain: []string{"a"}},
			{ID: "k2", Domain: []string{"0"}},
		}},
	}}
	constraints := []Constraint{PrimaryKey("pk_pair", "pair", "k1", "k2")}
	result, err := Solve(spec, constraints)
	if err != nil {
		t.Fatalf("Solve 返回错误: %v", err)
	}
	if result.Satisfiable {
		t.Fatalf("唯一组合数不足时应不可满足")
	}
	if len(result.Unsat.MUS) != 1 || result.Unsat.MUS[0] != "pk_pair" {
		t.Fatalf("单元素 MUS 应为 pk_pair，实际为 %v", result.Unsat.MUS)
	}
	assertMUSByEnumeration(t, spec, constraints, result.Unsat)
}
