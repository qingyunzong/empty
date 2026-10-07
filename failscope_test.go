package failscope

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
)

var errOuter = errors.New("outer failure")
var errInner = errors.New("inner failure")

// 嵌套叠加：内层同名规则优先；退出内层作用域后父规则恢复。
func TestNestedScopesInnerWinsAndParentRestored(t *testing.T) {
	outer := NewRule("db", errOuter)
	ctx := context.Background()
	outerCtx := WithRules(ctx, outer)

	inner := NewRule("db", errInner)
	innerCtx := WithRules(outerCtx, inner)

	if err := Inject(innerCtx, "db"); !errors.Is(err, errInner) {
		t.Fatalf("内层作用域应命中内层规则, got %v", err)
	}
	// 内层规则已耗尽，且遮蔽外层（不回退）。
	if err := Inject(innerCtx, "db"); err != nil {
		t.Fatalf("内层规则耗尽后应返回 nil 且遮蔽外层, got %v", err)
	}
	if outer.Hits() != 0 {
		t.Fatalf("外层规则不应被内层作用域消耗, hits=%d", outer.Hits())
	}

	// 退出内层作用域（回到 outerCtx），父规则仍在且可命中。
	if err := Inject(outerCtx, "db"); !errors.Is(err, errOuter) {
		t.Fatalf("退出内层后父规则应恢复并可命中, got %v", err)
	}
	if outer.Hits() != 1 || inner.Hits() != 1 {
		t.Fatalf("命中账错误: outer=%d inner=%d", outer.Hits(), inner.Hits())
	}
}

// panic 被 recover 后，父作用域规则不受影响。
func TestPanicRestoresParentRules(t *testing.T) {
	outer := NewRule("net", errOuter)
	outerCtx := WithRules(context.Background(), outer)

	func() {
		defer func() {
			if r := recover(); r == nil {
				t.Error("预期 panic")
			}
		}()
		innerCtx := WithRules(outerCtx, NewRule("net", errInner))
		if err := Inject(innerCtx, "net"); !errors.Is(err, errInner) {
			t.Fatalf("内层应命中, got %v", err)
		}
		panic("boom")
	}()

	// panic 之后回到父 context，父规则仍然完好。
	if err := Inject(outerCtx, "net"); !errors.Is(err, errOuter) {
		t.Fatalf("panic 后父规则应恢复, got %v", err)
	}
	if outer.Hits() != 1 {
		t.Fatalf("父规则命中账应为 1, got %d", outer.Hits())
	}
}

// 规则一次命中后耗尽；Report 输出实际命中账。
func TestRuleExhaustsAfterOneHitAndReport(t *testing.T) {
	db := NewRule("db", errOuter)
	cache := NewRule("cache", errInner)
	ctx := WithRules(context.Background(), db, cache)

	if err := Inject(ctx, "db"); !errors.Is(err, errOuter) {
		t.Fatalf("首次应命中, got %v", err)
	}
	if err := Inject(ctx, "db"); err != nil {
		t.Fatalf("第二次应耗尽返回 nil, got %v", err)
	}
	if err := Inject(ctx, "unknown"); err != nil {
		t.Fatalf("未配置的注入点应返回 nil, got %v", err)
	}

	report := Report(ctx)
	want := map[string]int64{"db": 1, "cache": 0}
	if fmt.Sprint(report) != fmt.Sprint(want) {
		t.Fatalf("命中账不符: got %v want %v", report, want)
	}
}

// 并发认领同一条规则：一次性语义在竞争下仍然成立。
func TestConcurrentClaimSingleRule(t *testing.T) {
	r := NewRule("db", errOuter)
	ctx := WithRules(context.Background(), r)

	const goroutines = 64
	bar := newBarrier(goroutines)
	var wg sync.WaitGroup
	var hits atomic64
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			bar.wait() // 屏障对齐，最大化竞争
			if Inject(ctx, "db") != nil {
				hits.Add(1)
			}
		}()
	}
	wg.Wait()

	if got := hits.Load(); got != 1 {
		t.Fatalf("一次性规则在并发下应只命中 1 次, got %d", got)
	}
	if r.Hits() != 1 {
		t.Fatalf("命中账应为 1, got %d", r.Hits())
	}
}

// 屏障验证并发隔离：每个 goroutine 各自叠加同名规则的作用域，
// 在屏障处对齐确认所有作用域同时存活，注入后互不污染。
func TestBarrierConcurrentScopeIsolation(t *testing.T) {
	shared := NewRule("db", errOuter) // 外层共享规则
	parent := WithRules(context.Background(), shared)

	const goroutines = 32
	barEnter := newBarrier(goroutines)
	barExit := newBarrier(goroutines)
	innerRules := make([]*Rule, goroutines)
	results := make([]error, goroutines)

	var wg sync.WaitGroup
	for i := 0; i < goroutines; i++ {
		innerRules[i] = NewRule("db", fmt.Errorf("inner-%d", i))
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			// 各自在共享父作用域上叠加私有内层作用域。
			ctx := WithRules(parent, innerRules[i])
			barEnter.wait() // 屏障：所有作用域同时存活
			results[i] = Inject(ctx, "db")
			barExit.wait() // 屏障：确认无 goroutine 提前退出作用域
			if err := Inject(ctx, "db"); err != nil {
				t.Errorf("goroutine %d: 自己的规则耗尽后不应命中共享规则, got %v", i, err)
			}
		}(i)
	}
	wg.Wait()

	for i, err := range results {
		want := fmt.Sprintf("inner-%d", i)
		if err == nil || err.Error() != want {
			t.Errorf("goroutine %d: 应命中自己的规则 %s, got %v", i, want, err)
		}
		if innerRules[i].Hits() != 1 {
			t.Errorf("goroutine %d: 私有规则命中账应为 1, got %d", i, innerRules[i].Hits())
		}
	}
	// 共享父规则未被任何内层作用域消耗，退出后仍可命中。
	if shared.Hits() != 0 {
		t.Fatalf("共享规则被污染, hits=%d", shared.Hits())
	}
	if err := Inject(parent, "db"); !errors.Is(err, errOuter) {
		t.Fatalf("并发作用域退出后共享规则应可命中, got %v", err)
	}
}

// barrier 是一次性会合屏障：n 个 goroutine 全部到达后同时放行。
type barrier struct {
	n       int
	count   int
	mu      sync.Mutex
	release chan struct{}
}

func newBarrier(n int) *barrier {
	return &barrier{n: n, release: make(chan struct{})}
}

func (b *barrier) wait() {
	b.mu.Lock()
	b.count++
	if b.count == b.n {
		close(b.release)
	}
	ch := b.release
	done := b.count == b.n
	b.mu.Unlock()
	if !done {
		<-ch
	}
}

// atomic64 是测试用的简单原子计数器。
type atomic64 struct {
	mu sync.Mutex
	v  int64
}

func (a *atomic64) Add(d int64) { a.mu.Lock(); a.v += d; a.mu.Unlock() }
func (a *atomic64) Load() int64 { a.mu.Lock(); defer a.mu.Unlock(); return a.v }
