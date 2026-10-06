package quotatree

import (
	"math/rand"
	"strconv"
	"testing"
)

func build(t *testing.T) *Tree {
	t.Helper()
	tr := NewTree("root", 1000)
	for _, a := range [][3]interface{}{
		{"root", "a", int64(400)},
		{"root", "b", int64(400)},
		{"a", "a1", int64(150)},
		{"a", "a2", int64(150)},
		{"b", "b1", int64(150)},
	} {
		if err := tr.AddNode(a[0].(string), a[1].(string), a[2].(int64)); err != nil {
			t.Fatalf("AddNode: %v", err)
		}
	}
	return tr
}

func total(t *testing.T, tr *Tree, id string) int64 {
	t.Helper()
	n, ok := tr.Get(id)
	if !ok {
		t.Fatalf("node %q missing", id)
	}
	return n.Total
}

func TestClaimAggregatesToAncestors(t *testing.T) {
	tr := build(t)
	if err := tr.Claim("a1", 60); err != nil {
		t.Fatal(err)
	}
	if err := tr.Claim("a2", 40); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]int64{"a1": 60, "a2": 40, "a": 100, "root": 100, "b": 0} {
		if got := total(t, tr, id); got != want {
			t.Errorf("total(%s) = %d, want %d", id, got, want)
		}
	}
	if err := tr.Verify(); err != nil {
		t.Fatal(err)
	}
}

func TestMoveSuccessReaggregates(t *testing.T) {
	tr := build(t)
	tr.Claim("a1", 60)
	tr.Claim("b1", 50)
	if err := tr.Move("a1", "b"); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]int64{"a": 0, "b": 110, "root": 110, "a1": 60} {
		if got := total(t, tr, id); got != want {
			t.Errorf("total(%s) = %d, want %d", id, got, want)
		}
	}
	a, _ := tr.Get("a")
	if len(a.Children) != 1 {
		t.Errorf("a should have 1 child after move, got %d", len(a.Children))
	}
	if err := tr.Verify(); err != nil {
		t.Fatal(err)
	}
}

func TestMoveFailureKeepsState(t *testing.T) {
	tr := build(t)
	tr.Claim("a1", 100)
	tr.Claim("b1", 320) // b.Total=320, 余量 80 < a1 的 100
	before := map[string]int64{}
	for _, id := range []string{"root", "a", "b", "a1", "a2", "b1"} {
		before[id] = total(t, tr, id)
	}
	if err := tr.Move("a1", "b"); err == nil {
		t.Fatal("move should be rejected by quota check")
	}
	for id, want := range before {
		if got := total(t, tr, id); got != want {
			t.Errorf("total(%s) changed to %d after failed move, want %d", id, got, want)
		}
	}
	a, _ := tr.Get("a")
	if _, ok := a.Children["a1"]; !ok {
		t.Error("a1 must remain under a after failed move")
	}
	a1, _ := tr.Get("a1")
	if a1.Parent != a {
		t.Error("a1 parent pointer changed after failed move")
	}
	if err := tr.Verify(); err != nil {
		t.Fatal(err)
	}
}

func TestRootCannotMove(t *testing.T) {
	tr := build(t)
	if err := tr.Move("root", "a"); err == nil {
		t.Fatal("moving root must fail")
	}
	if err := tr.Verify(); err != nil {
		t.Fatal(err)
	}
}

func TestMoveCycleRejected(t *testing.T) {
	tr := build(t)
	for _, np := range []string{"a1", "a2", "a"} {
		if err := tr.Move("a", np); err == nil {
			t.Fatalf("moving a under %s must be rejected (cycle)", np)
		}
	}
	if err := tr.Verify(); err != nil {
		t.Fatal(err)
	}
}

func TestQuotaLoweredMarksOverLimit(t *testing.T) {
	tr := build(t)
	tr.Claim("a1", 120)
	if err := tr.SetQuota("a1", 100); err != nil {
		t.Fatal(err)
	}
	a1, _ := tr.Get("a1")
	if !a1.OverLimit {
		t.Error("a1 should be marked over-limit after quota lowered below usage")
	}
	a, _ := tr.Get("a")
	if a.OverLimit {
		t.Error("a (total 120 <= 400) must not be over-limit")
	}
	if err := tr.SetQuota("a1", 200); err != nil {
		t.Fatal(err)
	}
	if a1.OverLimit {
		t.Error("over-limit flag should clear after quota raised")
	}
	if err := tr.Verify(); err != nil {
		t.Fatal(err)
	}
}

func TestClaimMayExceedAndIsMarked(t *testing.T) {
	tr := build(t)
	if err := tr.Claim("a1", 200); err != nil {
		t.Fatal(err)
	}
	a1, _ := tr.Get("a1")
	if !a1.OverLimit {
		t.Error("a1 claimed 200 > quota 150, should be over-limit")
	}
	if err := tr.Verify(); err != nil {
		t.Fatal(err)
	}
}

// TestLongOperationSequence 用确定性随机序列混合 AddNode/Claim/Move/SetQuota，
// 每一步后逐节点重算核验整树。
func TestLongOperationSequence(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	tr := NewTree("n0", 100000)
	ids := []string{"n0"}
	next := 1

	randID := func() string { return ids[rng.Intn(len(ids))] }

	for step := 0; step < 5000; step++ {
		switch rng.Intn(4) {
		case 0: // 新增节点
			id := "n" + strconv.Itoa(next)
			next++
			if err := tr.AddNode(randID(), id, int64(rng.Intn(500))); err != nil {
				t.Fatalf("step %d AddNode: %v", step, err)
			}
			ids = append(ids, id)
		case 1: // 领取
			if err := tr.Claim(randID(), int64(rng.Intn(50))); err != nil {
				t.Fatalf("step %d Claim: %v", step, err)
			}
		case 2: // 移动（允许失败，失败后状态须保持一致）
			id, np := randID(), randID()
			_ = tr.Move(id, np)
		case 3: // 调整额度（允许下调至超额）
			if err := tr.SetQuota(randID(), int64(rng.Intn(300))); err != nil {
				t.Fatalf("step %d SetQuota: %v", step, err)
			}
		}
		if err := tr.Verify(); err != nil {
			t.Fatalf("step %d: %v", step, err)
		}
	}
	t.Logf("completed 5000 ops over %d nodes", len(ids))
}
