package provq

import (
	"fmt"
	"reflect"
	"sort"
	"testing"
	"time"
)

func mustRule(t *testing.T, db *DB, r Rule) {
	t.Helper()
	if err := db.AddRule(r); err != nil {
		t.Fatalf("AddRule(%+v): %v", r, err)
	}
}

func mustFact(t *testing.T, db *DB, rel string, vals ...string) int {
	t.Helper()
	id, err := db.AddFact(rel, vals...)
	if err != nil {
		t.Fatalf("AddFact(%s%v): %v", rel, vals, err)
	}
	return id
}

func sortedWitnesses(ws []Witness) []Witness {
	out := append([]Witness(nil), ws...)
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

func checkWitnesses(t *testing.T, db *DB, rel string, tuple Tuple, want ...Witness) {
	t.Helper()
	got := sortedWitnesses(db.Witnesses(rel, tuple...))
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Witnesses(%s%v) = %v, want %v", rel, tuple, got, want)
	}
}

// 删除一事实仅撤掉含它的见证，仍有替代者保留。
func TestDeleteKeepsAlternatives(t *testing.T) {
	db := New()
	mustRule(t, db, Rule{Head: Literal{"j", []Term{V("X"), V("Z")}},
		Body: []Literal{{"p", []Term{V("X"), V("Y")}}, {"q", []Term{V("Y"), V("Z")}}}})
	mustRule(t, db, Rule{Head: Literal{"j", []Term{V("X"), V("Z")}},
		Body: []Literal{{"r", []Term{V("X"), V("Z")}}}})
	p := mustFact(t, db, "p", "a", "b") // 0
	q := mustFact(t, db, "q", "b", "c") // 1
	r := mustFact(t, db, "r", "a", "c") // 2

	checkWitnesses(t, db, "j", Tuple{"a", "c"}, Witness(1<<p|1<<q), Witness(1<<r))

	db.DeleteFact(r) // 撤掉 {r}，替代者 {p,q} 保留
	checkWitnesses(t, db, "j", Tuple{"a", "c"}, Witness(1<<p|1<<q))

	db.DeleteFact(p) // 最后一个见证被撤，元组消失
	if got := db.Witnesses("j", "a", "c"); got != nil {
		t.Fatalf("after deleting all witnesses, got %v", got)
	}
	if n := len(db.Tuples("j")); n != 0 {
		t.Fatalf("len(Tuples(j)) = %d, want 0", n)
	}
}

// 去掉来源超集：单事实见证吸收包含它的多事实见证。
func TestSupersetWitnessRemoved(t *testing.T) {
	db := New()
	mustRule(t, db, Rule{Head: Literal{"m", []Term{V("X"), V("Z")}},
		Body: []Literal{{"p", []Term{V("X"), V("Z")}}}})
	mustRule(t, db, Rule{Head: Literal{"m", []Term{V("X"), V("Z")}},
		Body: []Literal{{"p", []Term{V("X"), V("Y")}}, {"q", []Term{V("Y"), V("Z")}}}})
	direct := mustFact(t, db, "p", "a", "c") // 0
	mustFact(t, db, "q", "c", "c")           // 1

	// 连接见证 {p(a,c),q(c,c)} 是单事实见证 {p(a,c)} 的超集，应被去掉。
	checkWitnesses(t, db, "m", Tuple{"a", "c"}, Witness(1<<direct))
}

// 见证沿派生链传递：中间派生关系的来源并入下游。
func TestDerivedChainProvenance(t *testing.T) {
	db := New()
	mustRule(t, db, Rule{Head: Literal{"j", []Term{V("X"), V("Z")}},
		Body: []Literal{{"p", []Term{V("X"), V("Y")}}, {"q", []Term{V("Y"), V("Z")}}}})
	mustRule(t, db, Rule{Head: Literal{"d", []Term{V("X"), V("W")}},
		Body: []Literal{{"j", []Term{V("X"), V("Y")}}, {"q", []Term{V("Y"), V("W")}}}})
	p := mustFact(t, db, "p", "a", "b")  // 0
	q1 := mustFact(t, db, "q", "b", "c") // 1
	q2 := mustFact(t, db, "q", "c", "d") // 2

	checkWitnesses(t, db, "d", Tuple{"a", "d"}, Witness(1<<p|1<<q1|1<<q2))

	db.DeleteFact(q1) // 中间事实被删，下游见证随之撤掉
	if got := db.Witnesses("d", "a", "d"); got != nil {
		t.Fatalf("after deleting intermediate fact, got %v", got)
	}
}

func TestRecursiveAndUnsafeRulesRejected(t *testing.T) {
	db := New()
	self := Rule{Head: Literal{"x", []Term{V("A")}}, Body: []Literal{{"x", []Term{V("A")}}}}
	if err := db.AddRule(self); err == nil {
		t.Fatal("self-recursive rule accepted")
	}
	mustRule(t, db, Rule{Head: Literal{"a", []Term{V("X")}}, Body: []Literal{{"b", []Term{V("X")}}}})
	mutual := Rule{Head: Literal{"b", []Term{V("X")}}, Body: []Literal{{"a", []Term{V("X")}}}}
	if err := db.AddRule(mutual); err == nil {
		t.Fatal("mutually recursive rule accepted")
	}
	unsafe := Rule{Head: Literal{"u", []Term{V("X"), V("Y")}}, Body: []Literal{{"a", []Term{V("X")}}}}
	if err := db.AddRule(unsafe); err == nil {
		t.Fatal("unsafe rule (unbound head variable) accepted")
	}
}

// --- 蛮力核对：至多 20 事实，枚举全部子集，核对最小见证 ---

// evalMask 用 idxs 中第 j 个事实对应掩码第 j 位的子集从头求值（不跟踪来源），
// 返回各派生关系可导出的元组。
func evalMask(db *DB, idxs []int, mask uint64) map[string]map[string]Tuple {
	avail := map[string][]Tuple{}
	for j, id := range idxs {
		if mask&(1<<uint(j)) != 0 {
			f := db.facts[id]
			avail[f.rel] = append(avail[f.rel], f.tuple)
		}
	}
	derived := map[string]map[string]Tuple{}
	for _, ri := range db.order {
		r := db.rules[ri]
		bindings := []binding{{}}
		for _, lit := range r.Body {
			var next []binding
			for _, b := range bindings {
				for _, tup := range avail[lit.Rel] {
					if nb, ok := unify(b, lit.Args, tup); ok {
						next = append(next, nb)
					}
				}
			}
			bindings = next
			if len(bindings) == 0 {
				break
			}
		}
		for _, b := range bindings {
			tup, ok := project(r.Head, b)
			if !ok {
				continue
			}
			m := derived[r.Head.Rel]
			if m == nil {
				m = map[string]Tuple{}
				derived[r.Head.Rel] = m
			}
			k := keyOf(tup)
			if _, dup := m[k]; !dup {
				m[k] = tup
				avail[r.Head.Rel] = append(avail[r.Head.Rel], tup)
			}
		}
	}
	return derived
}

// 事实 id 列表（仅含存活事实），枚举顺序即掩码位序。
func liveIDs(db *DB) []int {
	var idxs []int
	for i, f := range db.facts {
		if f.live {
			idxs = append(idxs, i)
		}
	}
	return idxs
}

// toGlobal 把相对 idxs 的局部掩码换算成全局事实位掩码。
func toGlobal(idxs []int, mask uint64) Witness {
	var w Witness
	for j, id := range idxs {
		if mask&(1<<uint(j)) != 0 {
			w |= 1 << uint(id)
		}
	}
	return w
}

// baseExpectation 直接计算基础关系的最小见证：每个匹配事实一个单元素见证。
func baseExpectation(db *DB, idxs []int) map[string]map[string][]Witness {
	best := map[string]map[string][]Witness{}
	for _, id := range idxs {
		f := db.facts[id]
		if db.derived[f.rel] {
			continue
		}
		m := best[f.rel]
		if m == nil {
			m = map[string][]Witness{}
			best[f.rel] = m
		}
		k := keyOf(f.tuple)
		m[k] = insertMinimal(m[k], Witness(1)<<uint(id))
	}
	return best
}

// bruteForce 枚举 idxs 的全部子集，汇总每个元组的最小（按包含关系）来源集合。
func bruteForce(db *DB, idxs []int) map[string]map[string][]Witness {
	best := baseExpectation(db, idxs)
	for mask := uint64(0); mask < (uint64(1) << uint(len(idxs))); mask++ {
		for rel, tuples := range evalMask(db, idxs, mask) {
			m := best[rel]
			if m == nil {
				m = map[string][]Witness{}
				best[rel] = m
			}
			for k := range tuples {
				m[k] = insertMinimal(m[k], toGlobal(idxs, mask))
			}
		}
	}
	return best
}

// checkExpectation 核对 db 当前的输出与期望最小见证完全一致。
func checkExpectation(t *testing.T, db *DB, want map[string]map[string][]Witness, label string) {
	t.Helper()
	rels := map[string]bool{}
	for rel := range want {
		rels[rel] = true
	}
	for rel := range db.out {
		rels[rel] = true
	}
	for rel := range rels {
		got := map[string][]Witness{}
		for k, e := range db.out[rel] {
			got[k] = sortedWitnesses(e.witnesses)
		}
		exp := map[string][]Witness{}
		for k, ws := range want[rel] {
			exp[k] = sortedWitnesses(ws)
		}
		if !reflect.DeepEqual(got, exp) {
			t.Fatalf("%s: rel %s mismatch\n got: %v\nwant: %v", label, rel, got, exp)
		}
	}
}

// withoutFact 过滤掉含 id 的见证；删事实不会产生新见证，故过滤后仍是最小集合。
func withoutFact(want map[string]map[string][]Witness, id int) map[string]map[string][]Witness {
	bit := Witness(1) << uint(id)
	out := map[string]map[string][]Witness{}
	for rel, tuples := range want {
		m := map[string][]Witness{}
		for k, ws := range tuples {
			kept := make([]Witness, 0, len(ws))
			for _, w := range ws {
				if w&bit == 0 {
					kept = append(kept, w)
				}
			}
			if len(kept) > 0 {
				m[k] = kept
			}
		}
		if len(m) > 0 {
			out[rel] = m
		}
	}
	return out
}

func buildBenchmarkDB(t *testing.T) *DB {
	t.Helper()
	db := New()
	mustRule(t, db, Rule{Head: Literal{"j", []Term{V("X"), V("Z")}},
		Body: []Literal{{"p", []Term{V("X"), V("Y")}}, {"q", []Term{V("Y"), V("Z")}}}})
	mustRule(t, db, Rule{Head: Literal{"j", []Term{V("X"), V("Z")}},
		Body: []Literal{{"r", []Term{V("X"), V("Z")}}}})
	mustRule(t, db, Rule{Head: Literal{"d", []Term{V("X"), V("W")}},
		Body: []Literal{{"j", []Term{V("X"), V("Y")}}, {"q", []Term{V("Y"), V("W")}}}})
	mustRule(t, db, Rule{Head: Literal{"t", []Term{V("X")}},
		Body: []Literal{{"j", []Term{V("X"), V("Y")}}, {"s", []Term{V("Y")}}}})
	mustRule(t, db, Rule{Head: Literal{"k", []Term{V("X")}},
		Body: []Literal{{"p", []Term{V("X"), C("k")}}}})

	facts := []struct {
		rel  string
		vals []string
	}{
		{"p", []string{"a", "b"}}, {"p", []string{"a", "k"}}, {"p", []string{"b", "c"}},
		{"p", []string{"c", "d"}}, {"p", []string{"d", "a"}}, {"p", []string{"b", "k"}},
		{"q", []string{"b", "c"}}, {"q", []string{"c", "d"}}, {"q", []string{"d", "a"}},
		{"q", []string{"a", "b"}}, {"q", []string{"k", "c"}}, {"q", []string{"c", "a"}},
		{"r", []string{"a", "c"}}, {"r", []string{"b", "d"}}, {"r", []string{"c", "a"}},
		{"r", []string{"d", "b"}},
		{"s", []string{"c"}}, {"s", []string{"d"}}, {"s", []string{"a"}}, {"s", []string{"b"}},
	}
	if len(facts) > 20 {
		t.Fatalf("benchmark uses %d facts, want at most 20", len(facts))
	}
	for _, f := range facts {
		mustFact(t, db, f.rel, f.vals...)
	}
	return db
}

// 20 个事实，枚举全部 2^20 个子集核对每个输出元组的最小见证；
// 再逐一删除每个事实，核对增量撤掉后的见证仍与枚举结果一致；
// 最后对两个事实做独立的 2^19 子集重枚举，交叉验证删除路径。
func TestBruteForceMinimalWitnesses(t *testing.T) {
	db := buildBenchmarkDB(t)
	idxs := liveIDs(db)
	n := len(idxs)
	if n > 20 {
		t.Fatalf("%d facts, want at most 20", n)
	}

	start := time.Now()
	full := bruteForce(db, idxs)
	t.Logf("enumerated %d subsets over %d facts in %v", 1<<uint(n), n, time.Since(start))
	checkExpectation(t, db, full, "full set")

	for id := 0; id < n; id++ {
		sub := buildBenchmarkDB(t)
		sub.DeleteFact(id)
		checkExpectation(t, sub, withoutFact(full, id), fmt.Sprintf("after DeleteFact(%d)", id))
	}

	for _, id := range []int{0, n - 1} {
		sub := buildBenchmarkDB(t)
		sub.DeleteFact(id)
		start := time.Now()
		want := bruteForce(sub, liveIDs(sub))
		t.Logf("re-enumerated %d subsets after DeleteFact(%d) in %v", 1<<uint(n-1), id, time.Since(start))
		checkExpectation(t, sub, want, fmt.Sprintf("independent re-enumeration without fact %d", id))
	}
}
