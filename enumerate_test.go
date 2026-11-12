package dataeng_test

import (
	"math/big"
	"sort"
	"testing"

	dataeng "example.org/dataeng/q0307"
)

// enumerate 是独立于包内变量消元实现的全世界枚举参考，仅用于小域核对。
// 它显式枚举所有未被证据固定的变量（含未出现在任何因子中的变量）。
func enumerate(
	t *testing.T,
	vars []dataeng.Variable,
	factors []dataeng.Factor,
	q []string,
	evidence map[string]string,
) (map[string]*big.Rat, *big.Rat) {
	t.Helper()
	evDom := make(map[string]int)
	for id, val := range evidence {
		evDom[id] = indexOf(mustVar(vars, id).Domain, val)
	}

	free := make([]dataeng.Variable, 0)
	for _, v := range vars {
		if _, fixed := evDom[v.ID]; !fixed {
			free = append(free, v)
		}
	}

	assign := make(map[string]int)
	total := make(map[string]*big.Rat)
	z := big.NewRat(0, 1)

	var walk func(int)
	walk = func(pos int) {
		if pos == len(free) {
			prod := big.NewRat(1, 1)
			for _, f := range factors {
				if row := findRow(vars, f, assign, evDom); row != nil {
					prod.Mul(prod, row.Value)
				} else {
					prod.SetInt64(0) // 未列项精确为 0
					break
				}
			}
			if prod.Sign() == 0 {
				return
			}
			key := qKey(q, assign)
			if acc, ok := total[key]; ok {
				acc.Add(acc, prod)
			} else {
				total[key] = new(big.Rat).Set(prod)
			}
			z.Add(z, prod)
			return
		}
		v := free[pos]
		for d := range v.Domain {
			assign[v.ID] = d
			walk(pos + 1)
		}
		delete(assign, v.ID)
	}
	walk(0)
	return total, z
}

func mustVar(vars []dataeng.Variable, id string) dataeng.Variable {
	for _, v := range vars {
		if v.ID == id {
			return v
		}
	}
	panic("unknown variable " + id)
}

func indexOf(domain []string, val string) int {
	for i, d := range domain {
		if d == val {
			return i
		}
	}
	panic("unknown domain value " + val)
}

func findRow(
	vars []dataeng.Variable,
	f dataeng.Factor,
	assign map[string]int,
	evDom map[string]int,
) *dataeng.Entry {
	for i := range f.Entries {
		match := true
		for j, id := range f.Scope {
			want, ok := assign[id]
			if !ok {
				want = evDom[id]
			}
			if want != indexOf(mustVar(vars, id).Domain, f.Entries[i].Assignment[j]) {
				match = false
				break
			}
		}
		if match {
			return &f.Entries[i]
		}
	}
	return nil
}

func qKey(q []string, assign map[string]int) string {
	key := make([]byte, len(q))
	for i, id := range q {
		key[i] = byte(assign[id])
	}
	return string(key)
}

func rat(n, d int64) *big.Rat { return big.NewRat(n, d) }

// assertAgainstEnumerator 用全世界枚举核对状态、U、Z、规范化概率与轴顺序。
func assertAgainstEnumerator(
	t *testing.T,
	name string,
	vars []dataeng.Variable,
	factors []dataeng.Factor,
	q []string,
	ev map[string]string,
	budget int64,
) *dataeng.QueryResult {
	t.Helper()
	model, err := dataeng.NewModel(vars, factors)
	if err != nil {
		t.Fatalf("%s: NewModel: %v", name, err)
	}
	res, err := model.Query(q, ev, big.NewInt(budget))
	if err != nil {
		t.Fatalf("%s: Query: %v", name, err)
	}
	if res.Status != dataeng.StatusOK {
		t.Fatalf("%s: status=%s want ok", name, res.Status)
	}

	want, wantZ := enumerate(t, vars, factors, q, ev)
	if res.Z.Cmp(wantZ) != 0 {
		t.Fatalf("%s: Z=%s want %s", name, res.Z.RatString(), wantZ.RatString())
	}
	if len(res.U) != len(want) {
		t.Fatalf("%s: sparse U length=%d want %d", name, len(res.U), len(want))
	}

	gotKeys := make([]string, 0, len(res.U))
	for i, e := range res.U {
		if len(e.Assignment) != len(q) {
			t.Fatalf("%s: entry %d axis length mismatch", name, i)
		}
		key := make([]byte, len(q))
		for j, id := range q {
			key[j] = byte(indexOf(mustVar(vars, id).Domain, e.Assignment[j]))
		}
		sk := string(key)
		gotKeys = append(gotKeys, sk)
		if want[sk].Cmp(e.Value) != 0 {
			t.Fatalf("%s: U mismatch: got %s want %s", name, e.Value.RatString(), want[sk].RatString())
		}
		wantP := new(big.Rat).Quo(want[sk], wantZ)
		if res.Probability[i].Value.Cmp(wantP) != 0 {
			t.Fatalf("%s: P mismatch: got %s want %s", name, res.Probability[i].Value.RatString(), wantP.RatString())
		}
	}
	if !sort.StringsAreSorted(gotKeys) {
		t.Fatalf("%s: U not in canonical tuple order", name)
	}
	return res
}
