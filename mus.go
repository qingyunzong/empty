package dataeng

import "sort"

// Solve 生成字典序最小的合法夹具。
//
// 展平顺序为表 ID 字典序、行位置 0..n-1、列 ID 字典序；每个单元格按域索引
// 0..k-1 升序取值，可空列的 NULL 排在所有域索引之后（输出中记为 Null）。
// 可满足时返回 Result.Satisfiable=true 与 Fixture；不可满足时返回最小不可满足
// 约束子集（MUS）以及删除 MUS 中任一约束后的字典序最小夹具证书。
func Solve(spec Spec, constraints []Constraint) (*Result, error) {
	if err := Validate(spec, constraints); err != nil {
		return nil, err
	}

	if fixture, ok := solve(spec, constraints); ok {
		return &Result{Satisfiable: true, Fixture: fixture}, nil
	}

	mus := extractMUS(spec, constraints)
	musSet := map[string]bool{}
	for _, name := range mus {
		musSet[name] = true
	}

	report := &UnsatReport{
		MUS:               mus,
		Certificates:      map[string]*Fixture{},
		CertificateScopes: map[string][]string{},
	}
	for _, name := range mus {
		// 首选证书：全集 C 删除 name。若仍不可满足（name 之外还有独立冲突），
		// 退化为 MUS 删除 name——MUS 的极小性保证该子集可满足。
		fullMinusOne := filterConstraints(constraints, func(c Constraint) bool {
			return c.Name != name
		})
		fixture, ok := solve(spec, fullMinusOne)
		scope := sortedConstraintNames(fullMinusOne)
		if !ok {
			musMinusOne := filterConstraints(constraints, func(c Constraint) bool {
				return musSet[c.Name] && c.Name != name
			})
			fixture, ok = solve(spec, musMinusOne)
			if !ok {
				// 理论上不可达：MUS 的任一真子集均可满足。
				panic("dataeng: MUS 真子集仍不可满足，MUS 提取存在错误")
			}
			scope = sortedConstraintNames(musMinusOne)
		}
		report.Certificates[name] = fixture
		report.CertificateScopes[name] = scope
	}
	return &Result{Satisfiable: false, Unsat: report}, nil
}

// extractMUS 用删除法求子集极小的不可满足约束集合，结果按约束名排序。
// 约束数极少（<=5 表、约束规模与总单元格数均受限），线性次 SAT 调用即可。
func extractMUS(spec Spec, constraints []Constraint) []string {
	working := append([]Constraint(nil), constraints...)
	for i := 0; i < len(working); {
		trial := append([]Constraint(nil), working[:i]...)
		trial = append(trial, working[i+1:]...)
		if _, ok := solve(spec, trial); !ok {
			// 删除 working[i] 后仍不可满足，说明它不是必要成员。
			working = trial
		} else {
			i++
		}
	}
	names := sortedConstraintNames(working)
	sort.Strings(names)
	return names
}

func filterConstraints(constraints []Constraint, keep func(Constraint) bool) []Constraint {
	out := make([]Constraint, 0, len(constraints))
	for _, c := range constraints {
		if keep(c) {
			out = append(out, c)
		}
	}
	return out
}
