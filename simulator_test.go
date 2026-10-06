package locksim

import (
	"errors"
	"reflect"
	"testing"
)

func mustLock(t *testing.T, s *Simulator, task *Task, l *Lock) {
	t.Helper()
	if err := s.Lock(task, l); err != nil {
		t.Fatalf("Lock(%s, %s) unexpected error: %v", task.name, l.name, err)
	}
}

func mustUnlock(t *testing.T, s *Simulator, task *Task, l *Lock) {
	t.Helper()
	if err := s.Unlock(task, l); err != nil {
		t.Fatalf("Unlock(%s, %s) unexpected error: %v", task.name, l.name, err)
	}
}

// 基础捐赠：低优任务持锁，高优任务等待 → 持有者被抬升到等待者优先级。
func TestBasicDonation(t *testing.T) {
	s := NewSimulator()
	low := s.NewTask("low", 1)
	high := s.NewTask("high", 10)
	mu := s.NewLock("mu")

	mustLock(t, s, low, mu)
	if got := s.Priority(low); got != 1 {
		t.Fatalf("before wait: low eff = %d, want 1", got)
	}
	mustLock(t, s, high, mu)
	if got := s.Priority(low); got != 10 {
		t.Fatalf("after wait: low eff = %d, want 10", got)
	}
	if got := s.Priority(high); got != 10 {
		t.Fatalf("high eff = %d, want 10", got)
	}
}

// 链式捐赠：T1 持 L1；T2 持 L2 等 L1；T3 等 L2 → 最大值沿链传到 T1。
func TestChainDonation(t *testing.T) {
	s := NewSimulator()
	t1 := s.NewTask("t1", 1)
	t2 := s.NewTask("t2", 5)
	t3 := s.NewTask("t3", 9)
	l1 := s.NewLock("l1")
	l2 := s.NewLock("l2")

	mustLock(t, s, t1, l1)
	mustLock(t, s, t2, l2)
	mustLock(t, s, t2, l1) // t2 等待 t1
	mustLock(t, s, t3, l2) // t3 等待 t2

	if got := s.Priority(t2); got != 9 {
		t.Fatalf("t2 eff = %d, want 9", got)
	}
	if got := s.Priority(t1); got != 9 {
		t.Fatalf("t1 eff = %d, want 9 (transitive)", got)
	}
}

// 多重等待：多个等待者向同一持有者捐赠，取最大值而非求和。
func TestMaxOfMultipleWaiters(t *testing.T) {
	s := NewSimulator()
	holder := s.NewTask("holder", 2)
	w1 := s.NewTask("w1", 4)
	w2 := s.NewTask("w2", 8)
	w3 := s.NewTask("w3", 6)
	mu := s.NewLock("mu")

	mustLock(t, s, holder, mu)
	mustLock(t, s, w1, mu)
	mustLock(t, s, w2, mu)
	mustLock(t, s, w3, mu)

	if got := s.Priority(holder); got != 8 {
		t.Fatalf("holder eff = %d, want 8 (max of waiters)", got)
	}
}

// 释放后撤回：持有者释放锁，捐赠来源消失，优先级回落到基础值。
func TestRevokeOnUnlock(t *testing.T) {
	s := NewSimulator()
	low := s.NewTask("low", 1)
	high := s.NewTask("high", 10)
	mu := s.NewLock("mu")

	mustLock(t, s, low, mu)
	mustLock(t, s, high, mu)
	if got := s.Priority(low); got != 10 {
		t.Fatalf("low eff = %d, want 10", got)
	}

	mustUnlock(t, s, low, mu) // 锁移交给 high
	if got := s.Priority(low); got != 1 {
		t.Fatalf("after unlock: low eff = %d, want 1 (donation revoked)", got)
	}
	if mu.owner != high {
		t.Fatalf("lock owner = %v, want high", mu.owner)
	}
}

// 部分撤回：持有者同时持两把锁，释放一把后另一把的捐赠仍保留。
func TestPartialRevokeMultipleLocks(t *testing.T) {
	s := NewSimulator()
	holder := s.NewTask("holder", 1)
	wa := s.NewTask("wa", 5)
	wb := s.NewTask("wb", 9)
	la := s.NewLock("la")
	lb := s.NewLock("lb")

	mustLock(t, s, holder, la)
	mustLock(t, s, holder, lb)
	mustLock(t, s, wa, la)
	mustLock(t, s, wb, lb)
	if got := s.Priority(holder); got != 9 {
		t.Fatalf("holder eff = %d, want 9", got)
	}

	mustUnlock(t, s, holder, lb) // 只释放 lb
	if got := s.Priority(holder); got != 5 {
		t.Fatalf("after releasing lb: holder eff = %d, want 5 (la donation remains)", got)
	}
	mustUnlock(t, s, holder, la)
	if got := s.Priority(holder); got != 1 {
		t.Fatalf("after releasing la: holder eff = %d, want 1", got)
	}
}

// 链上逐段释放：中段释放后，末端捐赠不再传到前端。
func TestChainRevokePropagates(t *testing.T) {
	s := NewSimulator()
	t1 := s.NewTask("t1", 1)
	t2 := s.NewTask("t2", 2)
	t3 := s.NewTask("t3", 9)
	l1 := s.NewLock("l1")
	l2 := s.NewLock("l2")

	mustLock(t, s, t1, l1)
	mustLock(t, s, t2, l2)
	mustLock(t, s, t2, l1)
	mustLock(t, s, t3, l2)
	if got := s.Priority(t1); got != 9 {
		t.Fatalf("t1 eff = %d, want 9", got)
	}

	mustUnlock(t, s, t2, l2) // t3 获得 l2，链断开
	if got := s.Priority(t1); got != 2 {
		t.Fatalf("after t2 releases l2: t1 eff = %d, want 2 (only t2's own base)", got)
	}
	if got := s.Priority(t3); got != 9 {
		t.Fatalf("t3 eff = %d, want 9", got)
	}
}

// 死锁：双方互持对方所需的锁，返回构成环的任务名而非无穷传播。
func TestDeadlockReturnsCycle(t *testing.T) {
	s := NewSimulator()
	a := s.NewTask("a", 3)
	b := s.NewTask("b", 4)
	la := s.NewLock("la")
	lb := s.NewLock("lb")

	mustLock(t, s, a, la)
	mustLock(t, s, b, lb)
	mustLock(t, s, a, lb) // a 等 b
	err := s.Lock(b, la)  // b 等 a → 成环
	if err == nil {
		t.Fatal("expected deadlock error, got nil")
	}
	var de *DeadlockError
	if !errors.As(err, &de) {
		t.Fatalf("error type = %T, want *DeadlockError", err)
	}
	want := []string{"b", "a", "b"}
	if !reflect.DeepEqual(de.Cycle, want) {
		t.Fatalf("cycle = %v, want %v", de.Cycle, want)
	}
	// 状态未被破坏：b 未进入 la 的等待队列
	if len(la.waiters) != 0 {
		t.Fatalf("la waiters = %d, want 0 after rejected lock", len(la.waiters))
	}
	if b.waiting != nil {
		t.Fatalf("b.waiting = %v, want nil after rejected lock", b.waiting.name)
	}
}

// 三方环：a→b→c→a。
func TestDeadlockThreePartyCycle(t *testing.T) {
	s := NewSimulator()
	a := s.NewTask("a", 1)
	b := s.NewTask("b", 2)
	c := s.NewTask("c", 3)
	la := s.NewLock("la")
	lb := s.NewLock("lb")
	lc := s.NewLock("lc")

	mustLock(t, s, a, la)
	mustLock(t, s, b, lb)
	mustLock(t, s, c, lc)
	mustLock(t, s, a, lb) // a 等 b
	mustLock(t, s, b, lc) // b 等 c
	err := s.Lock(c, la)  // c 等 a → 三方环
	if !IsDeadlock(err) {
		t.Fatalf("expected deadlock, got %v", err)
	}
	var de *DeadlockError
	errors.As(err, &de)
	want := []string{"c", "a", "b", "c"}
	if !reflect.DeepEqual(de.Cycle, want) {
		t.Fatalf("cycle = %v, want %v", de.Cycle, want)
	}
}

// 自锁：任务重复请求自己持有的锁直接报错（而非构成环）。
func TestSelfLockRejected(t *testing.T) {
	s := NewSimulator()
	a := s.NewTask("a", 1)
	mu := s.NewLock("mu")
	mustLock(t, s, a, mu)
	if err := s.Lock(a, mu); err == nil {
		t.Fatal("expected error re-locking held lock")
	}
}

// 固定点核验：多重等待交织时，重算结果与独立不动点方程一致。
func TestFixpointMatchesEquation(t *testing.T) {
	s := NewSimulator()
	// 菱形：low 持 l1、l2；m1 等 l1；m2 等 l2；high 等 m1 持有的 l3。
	low := s.NewTask("low", 1)
	m1 := s.NewTask("m1", 3)
	m2 := s.NewTask("m2", 4)
	high := s.NewTask("high", 7)
	l1 := s.NewLock("l1")
	l2 := s.NewLock("l2")
	l3 := s.NewLock("l3")

	mustLock(t, s, low, l1)
	mustLock(t, s, low, l2)
	mustLock(t, s, m1, l3)
	mustLock(t, s, m1, l1) // m1 等 low
	mustLock(t, s, m2, l2) // m2 等 low
	mustLock(t, s, high, l3)

	// 不动点方程：eff = max(base, 等待者 eff 的最大值)，沿无环等待图展开。
	var effOf func(t *Task) int
	effOf = func(t *Task) int {
		eff := t.base
		for _, l := range s.locks {
			if l.owner != t {
				continue
			}
			for _, w := range l.waiters {
				if we := effOf(w); we > eff {
					eff = we
				}
			}
		}
		return eff
	}
	for _, task := range []*Task{low, m1, m2, high} {
		if got, want := s.Priority(task), effOf(task); got != want {
			t.Fatalf("%s: eff = %d, want %d", task.name, got, want)
		}
	}
	if got := s.Priority(low); got != 7 {
		t.Fatalf("low eff = %d, want 7 (high 沿 m1 链传入)", got)
	}
	if got := s.Priority(m2); got != 4 {
		t.Fatalf("m2 eff = %d, want 4 (无人等待 m2)", got)
	}
}

// 唤醒顺序：FIFO，队首等待者获得锁。
func TestFIFOHandoff(t *testing.T) {
	s := NewSimulator()
	holder := s.NewTask("holder", 1)
	w1 := s.NewTask("w1", 5)
	w2 := s.NewTask("w2", 9)
	mu := s.NewLock("mu")

	mustLock(t, s, holder, mu)
	mustLock(t, s, w1, mu)
	mustLock(t, s, w2, mu)
	mustUnlock(t, s, holder, mu)
	if mu.owner != w1 {
		t.Fatalf("owner = %v, want w1 (FIFO)", mu.owner.name)
	}
	// w2 仍在等待，向新持有者 w1 捐赠
	if got := s.Priority(w1); got != 9 {
		t.Fatalf("w1 eff = %d, want 9 (w2 still donating)", got)
	}
}
