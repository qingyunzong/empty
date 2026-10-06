package quotatree

import (
	"errors"
	"fmt"
	"math/rand"
	"testing"
)

func mustAdd(t *testing.T, tr *Tree, parent, id string, limit int64) {
	t.Helper()
	if err := tr.Add(parent, id, limit); err != nil {
		t.Fatalf("Add(%s,%s): %v", parent, id, err)
	}
}

func mustClaim(t *testing.T, tr *Tree, id string, delta int64) {
	t.Helper()
	if err := tr.Claim(id, delta); err != nil {
		t.Fatalf("Claim(%s,%d): %v", id, delta, err)
	}
}

func total(t *testing.T, tr *Tree, id string) int64 {
	t.Helper()
	n, ok := tr.Get(id)
	if !ok {
		t.Fatalf("Get(%s) not found", id)
	}
	return n.Total()
}

// 构建固定树：
//
//	root(100)
//	├── a(40)
//	│   ├── a1(15)
//	│   └── a2(15)
//	└── b(50)
//	    └── b1(20)
func fixture(t *testing.T) *Tree {
	t.Helper()
	tr, err := New("root", 100)
	if err != nil {
		t.Fatal(err)
	}
	mustAdd(t, tr, "root", "a", 40)
	mustAdd(t, tr, "root", "b", 50)
	mustAdd(t, tr, "a", "a1", 15)
	mustAdd(t, tr, "a", "a2", 15)
	mustAdd(t, tr, "b", "b1", 20)
	return tr
}

func TestClaimAggregatesToAncestors(t *testing.T) {
	tr := fixture(t)
	mustClaim(t, tr, "a1", 10)
	mustClaim(t, tr, "b1", 5)

	for id, want := range map[string]int64{
		"a1": 10, "a": 10, "b1": 5, "b": 5, "root": 15, "a2": 0,
	} {
		if got := total(t, tr, id); got != want {
			t.Errorf("total(%s) = %d, want %d", id, got, want)
		}
	}
	if err := tr.Verify(); err != nil {
		t.Fatal(err)
	}
}

func TestClaimExceedsLimitFailsAtomically(t *testing.T) {
	tr := fixture(t)
	mustClaim(t, tr, "a1", 10)
	// a1 上限 15，再领 10 会超额；失败则一切不变。
	if err := tr.Claim("a1", 10); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("want ErrQuotaExceeded, got %v", err)
	}
	for id, want := range map[string]int64{"a1": 10, "a": 10, "root": 10} {
		if got := total(t, tr, id); got != want {
			t.Errorf("total(%s) = %d, want %d", id, got, want)
		}
	}
	// 祖先上限同样生效：root 上限 100，b1 领 95 会让 root 变 105。
	if err := tr.Claim("b1", 95); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("want ErrQuotaExceeded on ancestor, got %v", err)
	}
	if got := total(t, tr, "root"); got != 10 {
		t.Errorf("root total changed to %d after failed claim", got)
	}
}

func TestMoveSubtreeRecomputesBothChains(t *testing.T) {
	tr := fixture(t)
	mustClaim(t, tr, "a1", 10) // a 子树总量 10
	if err := tr.Move("a1", "b"); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]int64{
		"a1": 10, "a": 0, "b": 10, "root": 10,
	} {
		if got := total(t, tr, id); got != want {
			t.Errorf("total(%s) = %d, want %d", id, got, want)
		}
	}
	if p, _ := tr.Get("a1"); p.Parent() != "b" {
		t.Errorf("a1 parent = %q, want b", p.Parent())
	}
	if err := tr.Verify(); err != nil {
		t.Fatal(err)
	}
}

func TestMoveChecksNewAncestorsAtomically(t *testing.T) {
	tr := fixture(t)
	mustClaim(t, tr, "a1", 12) // a1 子树总量 12
	mustClaim(t, tr, "b1", 20) // b 总量 20，b 上限 50 -> 移入后 32 OK
	// 给 b 加一层受限父级不够，直接下调 b 的额度制造失败场景：
	// 但下调是允许的，所以改用更小的中间节点。
	mustAdd(t, tr, "b", "b2", 25) // b2 上限 25，移入 12 后 b2=12 OK，但再测超限
	mustClaim(t, tr, "b2", 20)    // b2=20，b=40

	before := map[string]int64{}
	for _, id := range []string{"root", "a", "a1", "b", "b1", "b2"} {
		before[id] = total(t, tr, id)
	}

	// a1(12) 移到 b2 下：b2 将变 32 > 25，必须失败且全部不变。
	if err := tr.Move("a1", "b2"); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("want ErrQuotaExceeded, got %v", err)
	}
	for id, want := range before {
		if got := total(t, tr, id); got != want {
			t.Errorf("total(%s) = %d, want %d (structure must be unchanged)", id, got, want)
		}
	}
	if p, _ := tr.Get("a1"); p.Parent() != "a" {
		t.Errorf("a1 parent = %q after failed move, want a", p.Parent())
	}
	if err := tr.Verify(); err != nil {
		t.Fatal(err)
	}
}

func TestMoveRejectsRootAndCycles(t *testing.T) {
	tr := fixture(t)
	if err := tr.Move("root", "a"); !errors.Is(err, ErrRootMovable) {
		t.Errorf("move root: want ErrRootMovable, got %v", err)
	}
	if err := tr.Move("a", "a1"); !errors.Is(err, ErrCycle) {
		t.Errorf("move a under descendant a1: want ErrCycle, got %v", err)
	}
	if err := tr.Move("a", "a"); !errors.Is(err, ErrCycle) {
		t.Errorf("move a under itself: want ErrCycle, got %v", err)
	}
	// 反向移动（祖先方向）合法。
	if err := tr.Move("a1", "root"); err != nil {
		t.Errorf("move a1 up to root should succeed: %v", err)
	}
	if err := tr.Verify(); err != nil {
		t.Fatal(err)
	}
}

func TestLowerLimitMarksOverQuota(t *testing.T) {
	tr := fixture(t)
	mustClaim(t, tr, "a1", 10)
	mustClaim(t, tr, "a2", 8) // a 总量 18
	if err := tr.SetLimit("a", 12); err != nil {
		t.Fatal(err)
	}
	a, _ := tr.Get("a")
	if !a.OverQuota() {
		t.Error("a should be over quota after lowering limit below total")
	}
	if got := a.Total(); got != 18 {
		t.Errorf("lowering limit must not change counts, a total = %d, want 18", got)
	}
	// 超额状态下继续领取仍被拒绝。
	if err := tr.Claim("a1", 1); !errors.Is(err, ErrQuotaExceeded) {
		t.Errorf("claim into over-quota branch: want ErrQuotaExceeded, got %v", err)
	}
	// 上调回额度后超额标记消失。
	if err := tr.SetLimit("a", 40); err != nil {
		t.Fatal(err)
	}
	if a.OverQuota() {
		t.Error("a should not be over quota after raising limit")
	}
}

func TestNegativeClaimReclaims(t *testing.T) {
	tr := fixture(t)
	mustClaim(t, tr, "a1", 10)
	if err := tr.Claim("a1", -4); err != nil {
		t.Fatal(err)
	}
	if got := total(t, tr, "root"); got != 6 {
		t.Errorf("root total = %d, want 6", got)
	}
	if err := tr.Claim("a1", -7); !errors.Is(err, ErrInvalidAmount) {
		t.Errorf("reclaim below zero: want ErrInvalidAmount, got %v", err)
	}
}

// TestLongOperationSequence 随机执行长操作序列，每步后逐节点重算核验。
func TestLongOperationSequence(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	tr, err := New("root", 100000)
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{"root"}
	for i := 0; i < 60; i++ {
		id := fmt.Sprintf("n%d", i)
		parent := ids[rng.Intn(len(ids))]
		if err := tr.Add(parent, id, int64(50+rng.Intn(2000))); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}

	snapshot := func() map[string][2]int64 {
		m := map[string][2]int64{}
		for _, id := range ids {
			n, _ := tr.Get(id)
			m[id] = [2]int64{n.Own(), n.Total()}
		}
		return m
	}
	checkUnchanged := func(snap map[string][2]int64, step int) {
		t.Helper()
		for _, id := range ids {
			n, _ := tr.Get(id)
			if got := [2]int64{n.Own(), n.Total()}; got != snap[id] {
				t.Fatalf("step %d: node %s changed after failed op: got %v, want %v",
					step, id, got, snap[id])
			}
		}
	}

	for step := 0; step < 3000; step++ {
		id := ids[rng.Intn(len(ids))]
		switch rng.Intn(4) {
		case 0: // 领取/回收
			n, _ := tr.Get(id)
			delta := int64(rng.Intn(200) - 50)
			snap := snapshot()
			err := tr.Claim(id, delta)
			if err != nil {
				if delta >= 0 && !errors.Is(err, ErrQuotaExceeded) {
					t.Fatalf("step %d: unexpected claim error: %v", step, err)
				}
				checkUnchanged(snap, step)
			} else if n.Own() < 0 {
				t.Fatalf("step %d: negative own after claim", step)
			}
		case 1: // 移动子树
			if id == "root" {
				continue
			}
			np := ids[rng.Intn(len(ids))]
			snap := snapshot()
			err := tr.Move(id, np)
			if err != nil {
				if !errors.Is(err, ErrQuotaExceeded) && !errors.Is(err, ErrCycle) {
					t.Fatalf("step %d: unexpected move error: %v", step, err)
				}
				checkUnchanged(snap, step)
			}
		case 2: // 调整额度（允许下调）
			if err := tr.SetLimit(id, int64(rng.Intn(3000))); err != nil {
				t.Fatalf("step %d: SetLimit: %v", step, err)
			}
		case 3: // 新增节点
			newID := fmt.Sprintf("x%d", step)
			if err := tr.Add(id, newID, int64(50+rng.Intn(2000))); err != nil {
				t.Fatalf("step %d: Add: %v", step, err)
			}
			ids = append(ids, newID)
		}
		if err := tr.Verify(); err != nil {
			t.Fatalf("step %d: Verify: %v", step, err)
		}
	}
	t.Logf("final tree: %d nodes, root total %d", tr.Len(), total(t, tr, "root"))
}

func TestErrorsOnUnknownNodes(t *testing.T) {
	tr := fixture(t)
	if err := tr.Claim("ghost", 1); !errors.Is(err, ErrNodeNotFound) {
		t.Errorf("claim ghost: %v", err)
	}
	if err := tr.Move("a", "ghost"); !errors.Is(err, ErrNodeNotFound) {
		t.Errorf("move to ghost: %v", err)
	}
	if err := tr.Add("root", "a", 1); !errors.Is(err, ErrDuplicateID) {
		t.Errorf("duplicate add: %v", err)
	}
}
