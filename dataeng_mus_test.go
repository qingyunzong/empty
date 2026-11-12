package dataeng

import (
	"math/rand"
	"testing"
)

// 两条非空循环外键形成环，且两列枚举域无公共值，任何取值都无法互相满足。
func TestSolveUnsatCyclicForeignKeys(t *testing.T) {
	spec := Spec{Tables: []Table{
		{ID: "a", Rows: 1, Columns: []Column{
			{ID: "b", Domain: []string{"x", "y"}},
		}},
		{ID: "b", Rows: 1, Columns: []Column{
			{ID: "a", Domain: []string{"p", "q"}},
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
	if result.Satisfiable {
		t.Fatalf("无公共枚举值的非空循环外键应不可满足")
	}
	assertMUSByEnumeration(t, spec, constraints, result.Unsat)
}

// 随机小规格：求解器输出与全枚举的首个合法夹具逐单元格一致；
// 不可满足时用穷举核验 MUS 极小性与删除证书。
func TestRandomSpecsAgainstEnumeration(t *testing.T) {
	rng := rand.New(rand.NewSource(172))
	for iter := 0; iter < 60; iter++ {
		spec, constraints := randomSpec(rng)
		if err := Validate(spec, constraints); err != nil {
			t.Fatalf("迭代 %d 生成了非法规格: %v", iter, err)
		}
		result, err := Solve(spec, constraints)
		if err != nil {
			t.Fatalf("迭代 %d Solve 错误: %v", iter, err)
		}

		var first *Fixture
		count := 0
		err = Enumerate(spec, constraints, 200000, func(f *Fixture) bool {
			if count == 0 {
				first = f
			}
			count++
			return false
		})
		if err == ErrEnumerationLimit {
			continue // 超出节点预算的随机样本跳过，保证测试确定性
		}
		if err != nil {
			t.Fatalf("迭代 %d Enumerate 错误: %v", iter, err)
		}

		if count == 0 {
			if result.Satisfiable {
				t.Fatalf("迭代 %d 穷举无解但求解器报告有解", iter)
			}
			assertMUSByEnumeration(t, spec, constraints, result.Unsat)
			continue
		}
		if !result.Satisfiable {
			t.Fatalf("迭代 %d 穷举存在解但求解器报告无解", iter)
		}
		for i := range first.Values {
			if result.Fixture.Values[i] != first.Values[i] {
				t.Fatalf("迭代 %d 求解器输出不是字典序最小解：索引 %d 为 %v，期望 %v",
					iter, i, result.Fixture.Values[i], first.Values[i])
			}
		}
	}
}

func TestValidateRejectsOutOfBoundsSpecs(t *testing.T) {
	overTables := Spec{Tables: make([]Table, MaxTables+1)}
	for i := range overTables.Tables {
		overTables.Tables[i] = Table{
			ID:   TableID("t" + string(rune('a'+i))),
			Rows: 1,
			Columns: []Column{{
				ID:     "c",
				Domain: []string{"v"},
			}},
		}
	}
	if err := overTables.Validate(); err == nil {
		t.Fatalf("超过 %d 张表应被拒绝", MaxTables)
	}

	overCells := Spec{Tables: []Table{
		{ID: "big", Rows: MaxTotalCells, Columns: []Column{
			{ID: "c1", Domain: []string{"v"}},
			{ID: "c2", Domain: []string{"v"}},
		}},
	}}
	if err := overCells.Validate(); err == nil {
		t.Fatalf("总单元格数超过 %d 应被拒绝", MaxTotalCells)
	}

	overDomain := Spec{Tables: []Table{
		{ID: "t", Rows: 1, Columns: []Column{
			{ID: "c", Domain: []string{"a", "b", "c", "d", "e"}},
		}},
	}}
	if err := overDomain.Validate(); err == nil {
		t.Fatalf("枚举域超过 %d 值应被拒绝", MaxDomainValues)
	}

	badFK := Spec{Tables: []Table{
		{ID: "t1", Rows: 1, Columns: []Column{{ID: "c", Domain: []string{"v"}}}},
		{ID: "t2", Rows: 1, Columns: []Column{{ID: "c", Domain: []string{"v"}}}},
	}}
	badConstraints := []Constraint{
		ForeignKey("fk_bad", "t1", "c", "t2", "missing"),
	}
	if err := Validate(badFK, badConstraints); err == nil {
		t.Fatalf("引用不存在列的外键应被拒绝")
	}
}

func assertLexMinimumByEnumeration(t *testing.T, spec Spec, constraints []Constraint, got *Fixture, maxNodes int) {
	t.Helper()
	var first *Fixture
	err := Enumerate(spec, constraints, maxNodes, func(f *Fixture) bool {
		first = f
		return true
	})
	if err != nil {
		t.Fatalf("全枚举失败: %v", err)
	}
	if first == nil {
		t.Fatalf("全枚举未产生任何合法夹具")
	}
	for i := range first.Values {
		if got.Values[i] != first.Values[i] {
			t.Fatalf("求解器夹具不是字典序最小：索引 %d 为 %v，枚举首解为 %v",
				i, got.Values[i], first.Values[i])
		}
	}
}

// assertMUSByEnumeration 用穷举独立核验：
//  1. MUS 本身不可满足；
//  2. 删除 MUS 中任一约束后可满足（子集极小性）；
//  3. 每份证书对其声明的约束范围合法，且为该范围内的字典序最小解。
func assertMUSByEnumeration(t *testing.T, spec Spec, constraints []Constraint, report *UnsatReport) {
	t.Helper()
	if report == nil || len(report.MUS) == 0 {
		t.Fatalf("不可满足结果缺少 MUS")
	}
	byName := map[string]Constraint{}
	for _, c := range constraints {
		byName[c.Name] = c
	}
	musConstraints := make([]Constraint, 0, len(report.MUS))
	for _, name := range report.MUS {
		c, ok := byName[name]
		if !ok {
			t.Fatalf("MUS 含未知约束名 %q", name)
		}
		musConstraints = append(musConstraints, c)
	}

	satCount := 0
	if err := Enumerate(spec, musConstraints, 500000, func(*Fixture) bool {
		satCount++
		return true
	}); err != nil {
		t.Fatalf("枚举 MUS 失败: %v", err)
	}
	if satCount != 0 {
		t.Fatalf("MUS %v 本身存在解，不是不可满足子集", report.MUS)
	}

	for _, name := range report.MUS {
		trial := filterConstraints(musConstraints, func(c Constraint) bool { return c.Name != name })
		var first *Fixture
		if err := Enumerate(spec, trial, 500000, func(f *Fixture) bool {
			first = f
			return true
		}); err != nil {
			t.Fatalf("枚举 MUS 删除 %q 失败: %v", name, err)
		}
		if first == nil {
			t.Fatalf("MUS 删除 %q 后仍不可满足，MUS 不满足极小性", name)
		}

		cert := report.Certificates[name]
		if cert == nil {
			t.Fatalf("缺少约束 %q 的删除证书", name)
		}
		scopeNames := report.CertificateScopes[name]
		scope := make([]Constraint, 0, len(scopeNames))
		for _, scopeName := range scopeNames {
			scope = append(scope, byName[scopeName])
		}
		ok, err := IsValid(spec, scope, cert)
		if err != nil || !ok {
			t.Fatalf("约束 %q 的证书对范围 %v 不合法: ok=%v err=%v", name, scopeNames, ok, err)
		}
		var scopeFirst *Fixture
		if err := Enumerate(spec, scope, 500000, func(f *Fixture) bool {
			scopeFirst = f
			return true
		}); err != nil {
			t.Fatalf("枚举证书范围失败: %v", err)
		}
		for i := range scopeFirst.Values {
			if cert.Values[i] != scopeFirst.Values[i] {
				t.Fatalf("约束 %q 的证书不是范围内字典序最小解：索引 %d 为 %v，期望 %v",
					name, i, cert.Values[i], scopeFirst.Values[i])
			}
		}
	}
}
