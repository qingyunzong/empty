package dataeng

import (
	"errors"
	"math/rand"
	"reflect"
	"testing"
)

func applyAll(t *testing.T, d *DistinctAgg, batches ...[]Update) [][]Change {
	t.Helper()
	var out [][]Change
	for _, b := range batches {
		changes, err := d.Apply(b)
		if err != nil {
			t.Fatalf("Apply(%v) unexpected error: %v", b, err)
		}
		out = append(out, changes)
	}
	return out
}

func TestTransitions(t *testing.T) {
	d := New(4)
	got := applyAll(t, d,
		[]Update{{Group: "g", Value: "a", Delta: 1}},
		[]Update{{Group: "g", Value: "a", Delta: 2}},  // 1->3，无输出
		[]Update{{Group: "g", Value: "a", Delta: -2}}, // 3->1，无输出
		[]Update{{Group: "g", Value: "a", Delta: -1}}, // 1->0
	)
	want := [][]Change{
		{{Group: "g", Value: "a", Delta: +1}},
		nil,
		nil,
		{{Group: "g", Value: "a", Delta: -1}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("changes = %v, want %v", got, want)
	}
	if snap := d.Snapshot(); len(snap) != 0 {
		t.Fatalf("final state not empty: %v", snap)
	}
}

func TestBatchNetting(t *testing.T) {
	d := New(1)
	// 同批次内 +1/-1 抵消，不产生输出，也不留状态。
	changes, err := d.Apply([]Update{
		{Group: "g", Value: "x", Delta: 1},
		{Group: "g", Value: "x", Delta: -1},
	})
	if err != nil || len(changes) != 0 {
		t.Fatalf("changes=%v err=%v, want no change", changes, err)
	}
	if snap := d.Snapshot(); len(snap) != 0 {
		t.Fatalf("state = %v, want empty", snap)
	}
	// 同批次内先撤回后插入同一新键，净额为 0，不应报冲突。
	if _, err := d.Apply([]Update{
		{Group: "g", Value: "y", Delta: -1},
		{Group: "g", Value: "y", Delta: 1},
	}); err != nil {
		t.Fatalf("net-zero batch on absent key got error: %v", err)
	}
}

func TestNullSemantics(t *testing.T) {
	d := New(2)
	// NULL 计入引用计数但不产生 distinct 输出。
	changes, err := d.Apply([]Update{
		{Group: "g", Value: nil, Delta: 3},
		{Group: "g", Value: "a", Delta: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []Change{{Group: "g", Value: "a", Delta: +1}}
	if !reflect.DeepEqual(changes, want) {
		t.Fatalf("changes = %v, want %v", changes, want)
	}
	if got := d.Snapshot()["g"][nil]; got != 3 {
		t.Fatalf("null refcount = %d, want 3", got)
	}
	// NULL 撤回跨越 0/1 边界同样无输出。
	changes, err = d.Apply([]Update{{Group: "g", Value: nil, Delta: -3}})
	if err != nil || len(changes) != 0 {
		t.Fatalf("changes=%v err=%v, want no change", changes, err)
	}
	// NULL 计数同样受非负约束。
	if _, err := d.Apply([]Update{{Group: "g", Value: nil, Delta: -1}}); err == nil {
		t.Fatal("expected conflict on negative null count")
	}
}

func TestConflictAtomic(t *testing.T) {
	d := New(4)
	applyAll(t, d, []Update{{Group: "g", Value: "b", Delta: 1}})
	before := d.Snapshot()

	_, err := d.Apply([]Update{
		{Group: "g", Value: "a", Delta: 1},  // 合法，但同批次有冲突
		{Group: "g", Value: "b", Delta: -2}, // 1-2 < 0，冲突
	})
	var ce *ConflictError
	if !errors.As(err, &ce) {
		t.Fatalf("err = %v, want *ConflictError", err)
	}
	if ce.Group != "g" || ce.Value != "b" || ce.Count != 1 || ce.Delta != -2 {
		t.Fatalf("conflict detail = %+v", ce)
	}
	if after := d.Snapshot(); !reflect.DeepEqual(after, before) {
		t.Fatalf("state mutated on conflict: before=%v after=%v", before, after)
	}
}

func TestUncomparableValue(t *testing.T) {
	d := New(1)
	_, err := d.Apply([]Update{{Group: "g", Value: []int{1}, Delta: 1}})
	if !errors.Is(err, ErrUncomparableValue) {
		t.Fatalf("err = %v, want ErrUncomparableValue", err)
	}
}

func TestUndo(t *testing.T) {
	d := New(3)
	batch := []Update{
		{Group: "g1", Value: "a", Delta: 2},
		{Group: "g1", Value: nil, Delta: 1},
		{Group: "g2", Value: "b", Delta: 1},
	}
	if _, err := d.Apply(batch); err != nil {
		t.Fatal(err)
	}
	changes, err := d.Undo(batch)
	if err != nil {
		t.Fatal(err)
	}
	want := []Change{
		{Group: "g1", Value: "a", Delta: -1},
		{Group: "g2", Value: "b", Delta: -1},
	}
	if !reflect.DeepEqual(changes, want) {
		t.Fatalf("undo changes = %v, want %v", changes, want)
	}
	if snap := d.Snapshot(); len(snap) != 0 {
		t.Fatalf("state after undo = %v, want empty", snap)
	}
}

func TestMerge(t *testing.T) {
	left, right := New(2), New(8) // 分片数不同也应可合并
	applyAll(t, left,
		[]Update{{Group: "g", Value: "a", Delta: 1}},
		[]Update{{Group: "h", Value: "x", Delta: 2}},
	)
	applyAll(t, right,
		[]Update{{Group: "g", Value: "a", Delta: 3}},
		[]Update{{Group: "g", Value: nil, Delta: 1}},
	)
	left.Merge(right)
	want := map[string]map[Value]int64{
		"g": {"a": 4, nil: 1},
		"h": {"x": 2},
	}
	if snap := left.Snapshot(); !reflect.DeepEqual(snap, want) {
		t.Fatalf("merged = %v, want %v", snap, want)
	}
}

// key 是参考模型中的 (group, value) 键。
type key struct {
	group string
	value Value
}

// distinctOf 从多重集重算 distinct 输出集合（排除 NULL）。
func distinctOf(ms map[key]int64) map[key]struct{} {
	out := make(map[key]struct{})
	for k, c := range ms {
		if c > 0 && k.value != nil {
			out[k] = struct{}{}
		}
	}
	return out
}

// TestRandomizedConsistency 随机生成批次（含 NULL、含非法撤回），
// 校验：冲突批次不改动状态；合法批次后状态与输出都与多重集重算一致。
func TestRandomizedConsistency(t *testing.T) {
	rng := rand.New(rand.NewSource(142))
	d := New(1 + rng.Intn(7))

	groups := []string{"g1", "g2", "g3", "g4"}
	values := []Value{nil, "a", "b", "c", 7, 8}

	multiset := make(map[key]int64)  // 参考输入多重集
	output := make(map[key]struct{}) // 由 Change 流累积的参考输出

	for step := 0; step < 3000; step++ {
		n := 1 + rng.Intn(5)
		batch := make([]Update, 0, n)
		for i := 0; i < n; i++ {
			u := Update{
				Group: groups[rng.Intn(len(groups))],
				Value: values[rng.Intn(len(values))],
				Delta: 1,
			}
			// 偏向对已有键撤回，少量完全随机（可能非法）。
			if r := rng.Intn(10); r < 4 {
				u.Delta = -1
				if rng.Intn(4) > 0 && len(multiset) > 0 {
					idx := rng.Intn(len(multiset))
					for k := range multiset {
						if idx == 0 {
							u.Group, u.Value = k.group, k.value
							break
						}
						idx--
					}
				}
			}
			batch = append(batch, u)
		}

		// 参考模型先判定是否冲突。
		nets := make(map[key]int64)
		for _, u := range batch {
			nets[key{u.Group, u.Value}] += u.Delta
		}
		conflict := false
		for k, net := range nets {
			if multiset[k]+net < 0 {
				conflict = true
				break
			}
		}

		before := d.Snapshot()
		changes, err := d.Apply(batch)
		if conflict {
			if err == nil {
				t.Fatalf("step %d: expected conflict for %v", step, batch)
			}
			if after := d.Snapshot(); !reflect.DeepEqual(after, before) {
				t.Fatalf("step %d: state mutated on conflict", step)
			}
			continue
		}
		if err != nil {
			t.Fatalf("step %d: unexpected error %v for %v", step, err, batch)
		}

		for k, net := range nets {
			c := multiset[k] + net
			if c == 0 {
				delete(multiset, k)
			} else {
				multiset[k] = c
			}
		}
		for _, ch := range changes {
			k := key{ch.Group, ch.Value}
			switch ch.Delta {
			case +1:
				if _, ok := output[k]; ok {
					t.Fatalf("step %d: duplicate +1 for %v", step, k)
				}
				output[k] = struct{}{}
			case -1:
				if _, ok := output[k]; !ok {
					t.Fatalf("step %d: -1 for absent %v", step, k)
				}
				delete(output, k)
			default:
				t.Fatalf("step %d: invalid change delta %d", step, ch.Delta)
			}
		}

		if snap := d.Snapshot(); !reflect.DeepEqual(snap, snapshotOf(multiset)) {
			t.Fatalf("step %d: state = %v, want recompute %v", step, snap, multiset)
		}
		if want := distinctOf(multiset); !reflect.DeepEqual(output, want) {
			t.Fatalf("step %d: output = %v, want recompute %v", step, output, want)
		}
	}
}

func snapshotOf(ms map[key]int64) map[string]map[Value]int64 {
	out := make(map[string]map[Value]int64)
	for k, c := range ms {
		if c <= 0 {
			continue
		}
		if out[k.group] == nil {
			out[k.group] = make(map[Value]int64)
		}
		out[k.group][k.value] = c
	}
	return out
}

// TestRandomizedMergeAndUndo 随机把更新分流到两个实例再合并，
// 然后全部撤销，校验各阶段都与多重集重算一致。
func TestRandomizedMergeAndUndo(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	left, right := New(3), New(5)
	models := map[*DistinctAgg]map[key]int64{left: {}, right: {}}
	var history [][]Update

	for step := 0; step < 300; step++ {
		target := left
		if rng.Intn(2) == 0 {
			target = right
		}
		model := models[target]
		u := Update{
			Group: []string{"g1", "g2", "g3"}[rng.Intn(3)],
			Value: []Value{nil, "a", "b", 9}[rng.Intn(4)],
			Delta: 1,
		}
		// 撤回必须路由到持有该键计数的实例。
		if rng.Intn(3) == 0 && len(model) > 0 {
			u.Delta = -1
			idx := rng.Intn(len(model))
			for k := range model {
				if idx == 0 {
					u.Group, u.Value = k.group, k.value
					break
				}
				idx--
			}
		}
		if _, err := target.Apply([]Update{u}); err != nil {
			t.Fatalf("step %d: %v", step, err)
		}
		history = append(history, []Update{u})
		k := key{u.Group, u.Value}
		if c := model[k] + u.Delta; c == 0 {
			delete(model, k)
		} else {
			model[k] = c
		}
	}

	left.Merge(right)
	multiset := make(map[key]int64)
	for _, model := range models {
		for k, c := range model {
			multiset[k] += c
		}
	}
	if snap := left.Snapshot(); !reflect.DeepEqual(snap, snapshotOf(multiset)) {
		t.Fatalf("merged state = %v, want recompute %v", snap, multiset)
	}

	// 逆序撤销全部历史后状态应为空。
	for i := len(history) - 1; i >= 0; i-- {
		if _, err := left.Undo(history[i]); err != nil {
			t.Fatalf("undo step %d: %v", i, err)
		}
	}
	if snap := left.Snapshot(); len(snap) != 0 {
		t.Fatalf("state after full undo = %v, want empty", snap)
	}
}
