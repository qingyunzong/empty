package faultinj_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"faultinj"
)

var (
	errOuter = errors.New("outer failure")
	errInner = errors.New("inner failure")
	errA     = errors.New("failure A")
	errB     = errors.New("failure B")
)

// Inner scopes take priority; a one-shot rule is exhausted after firing
// and the operation falls through to the outer scope.
func TestNestingInnerPriorityAndExhaustion(t *testing.T) {
	inj := faultinj.New()
	outer := faultinj.NewRule("outer-db", errOuter, faultinj.MatchOp("db.read"))
	inner := faultinj.NewRule("inner-db", errInner, faultinj.MatchOp("db.read"))

	ctx, exitOuter := inj.WithScope(context.Background(), "outer", outer)
	defer exitOuter()
	ctx, exitInner := inj.WithScope(ctx, "inner", inner)
	defer exitInner()

	if err := inj.Check(ctx, faultinj.Op("db.read")); !errors.Is(err, errInner) {
		t.Fatalf("first check: want inner error, got %v", err)
	}
	if !inner.Exhausted() {
		t.Fatal("inner rule should be exhausted after one hit")
	}
	if err := inj.Check(ctx, faultinj.Op("db.read")); !errors.Is(err, errOuter) {
		t.Fatalf("second check: want fallthrough to outer, got %v", err)
	}
	if err := inj.Check(ctx, faultinj.Op("db.read")); err != nil {
		t.Fatalf("third check: both rules exhausted, want nil, got %v", err)
	}
	if got := inj.Ledger().Len(); got != 2 {
		t.Fatalf("ledger: want 2 hits, got %d", got)
	}
}

// Non-matching operations are not affected by armed rules.
func TestNonMatchingOperationPasses(t *testing.T) {
	inj := faultinj.New()
	rule := faultinj.NewRule("db-only", errOuter, faultinj.MatchOp("db.read"))
	ctx, exit := inj.WithScope(context.Background(), "s", rule)
	defer exit()

	if err := inj.Check(ctx, faultinj.Op("http.get")); err != nil {
		t.Fatalf("non-matching op: want nil, got %v", err)
	}
	if rule.Exhausted() {
		t.Fatal("rule must stay armed for non-matching ops")
	}
}

// Exiting a scope restores the parent rules.
func TestExitRestoresParentRules(t *testing.T) {
	inj := faultinj.New()
	outer := faultinj.NewRule("outer", errOuter, faultinj.MatchOp("db"))
	inner := faultinj.NewRule("inner", errInner, faultinj.MatchOp("db"))

	ctx, exitOuter := inj.WithScope(context.Background(), "outer", outer)
	defer exitOuter()
	innerCtx, exitInner := inj.WithScope(ctx, "inner", inner)
	exitInner()

	// The inner context no longer sees the inner rule after exit.
	if err := inj.Check(innerCtx, faultinj.Op("db")); !errors.Is(err, errOuter) {
		t.Fatalf("after exit: want parent rule, got %v", err)
	}
	if inner.Exhausted() {
		t.Fatal("inner rule must remain armed: it was deactivated, not fired")
	}
}

// A deferred exit restores the parent rules even when the scope body panics.
func TestPanicRestoresParentRules(t *testing.T) {
	inj := faultinj.New()
	outer := faultinj.NewRule("outer", errOuter, faultinj.MatchOp("db"))
	inner := faultinj.NewRule("inner", errInner, faultinj.MatchOp("db"))

	ctx, exitOuter := inj.WithScope(context.Background(), "outer", outer)
	defer exitOuter()

	var innerCtx context.Context
	func() {
		defer func() {
			if r := recover(); r != "boom" {
				t.Fatalf("want panic 'boom', got %v", r)
			}
		}()
		var exitInner func()
		innerCtx, exitInner = inj.WithScope(ctx, "inner", inner)
		defer exitInner()
		panic("boom")
	}()

	if err := inj.Check(innerCtx, faultinj.Op("db")); !errors.Is(err, errOuter) {
		t.Fatalf("after panic: want parent rule restored, got %v", err)
	}
	hits := inj.Ledger().Hits()
	if len(hits) != 1 || hits[0].Scope != "outer" || hits[0].Rule != "outer" {
		t.Fatalf("ledger: want a single hit on the outer scope, got %+v", hits)
	}
	if inner.Exhausted() {
		t.Fatal("inner rule was deactivated by the panic exit, it must stay armed")
	}
}

// exit is idempotent.
func TestDoubleExitIsSafe(t *testing.T) {
	inj := faultinj.New()
	rule := faultinj.NewRule("r", errOuter, faultinj.MatchAll())
	ctx, exit := inj.WithScope(context.Background(), "s", rule)
	exit()
	exit()
	if err := inj.Check(ctx, faultinj.Op("x")); err != nil {
		t.Fatalf("after double exit: want nil, got %v", err)
	}
}

// Concurrent goroutines each carry their own scope chain; a barrier forces
// all scopes to be active at the same time to prove there is no pollution.
func TestConcurrentScopesAreIsolated(t *testing.T) {
	inj := faultinj.New()
	bar := faultinj.NewBarrier(3)
	ruleA := faultinj.NewRule("rule-a", errA, faultinj.MatchOp("work"))
	ruleB := faultinj.NewRule("rule-b", errB, faultinj.MatchOp("work"))

	results := make([]error, 3)
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			ctx := context.Background()
			var exit func()
			switch i {
			case 0:
				ctx, exit = inj.WithScope(ctx, "worker-a", ruleA)
			case 1:
				ctx, exit = inj.WithScope(ctx, "worker-b", ruleB)
			case 2:
				exit = func() {} // no scope at all
			}
			defer exit()
			bar.Await() // all three scopes (or lack thereof) are now active
			results[i] = inj.Check(ctx, faultinj.Op("work"))
			bar.Await() // hold scopes open until everyone has checked
		}(i)
	}
	wg.Wait()

	if !errors.Is(results[0], errA) {
		t.Fatalf("worker-a: want errA, got %v", results[0])
	}
	if !errors.Is(results[1], errB) {
		t.Fatalf("worker-b: want errB, got %v", results[1])
	}
	if results[2] != nil {
		t.Fatalf("scopeless worker: want nil, got %v", results[2])
	}

	hits := inj.Ledger().Hits()
	if len(hits) != 2 {
		t.Fatalf("ledger: want 2 hits, got %d", len(hits))
	}
	byScope := map[string]string{}
	for _, h := range hits {
		byScope[h.Scope] = h.Rule
	}
	if byScope["worker-a"] != "rule-a" || byScope["worker-b"] != "rule-b" {
		t.Fatalf("hit accounting mismatch: %v", byScope)
	}
}

// A rule fires exactly once no matter how many goroutines race on it.
func TestRuleFiresOnceUnderConcurrency(t *testing.T) {
	inj := faultinj.New()
	rule := faultinj.NewRule("shared", errA, faultinj.MatchAll())
	ctx, exit := inj.WithScope(context.Background(), "shared", rule)
	defer exit()

	const racers = 32
	bar := faultinj.NewBarrier(racers)
	errs := make([]error, racers)
	var wg sync.WaitGroup
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			bar.Await()
			errs[i] = inj.Check(ctx, faultinj.Op("work"))
		}(i)
	}
	wg.Wait()

	fired := 0
	for _, err := range errs {
		if errors.Is(err, errA) {
			fired++
		} else if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if fired != 1 {
		t.Fatalf("one-shot rule fired %d times", fired)
	}
	if got := inj.Ledger().Len(); got != 1 {
		t.Fatalf("ledger: want exactly 1 hit, got %d", got)
	}
}

// Nested scopes across goroutines: inner scopes of different workers never
// leak into each other even when interleaved by a barrier.
func TestNestedConcurrentScopes(t *testing.T) {
	inj := faultinj.New()
	bar := faultinj.NewBarrier(2)

	shared := faultinj.NewRule("shared-outer", errOuter, faultinj.MatchOp("db"))
	ctx, exitOuter := inj.WithScope(context.Background(), "shared", shared)
	defer exitOuter()

	innerA := faultinj.NewRule("inner-a", errA, faultinj.MatchOp("db"))
	innerB := faultinj.NewRule("inner-b", errB, faultinj.MatchOp("db"))
	results := make([]error, 4)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			rule, label := innerA, "inner-a"
			if i == 1 {
				rule, label = innerB, "inner-b"
			}
			innerCtx, exit := inj.WithScope(ctx, label, rule)
			defer exit()
			bar.Await()                                             // both inner scopes active simultaneously
			results[i*2] = inj.Check(innerCtx, faultinj.Op("db"))   // own inner rule
			results[i*2+1] = inj.Check(innerCtx, faultinj.Op("db")) // fallthrough to shared outer
		}(i)
	}
	wg.Wait()

	if !errors.Is(results[0], errA) || !errors.Is(results[2], errB) {
		t.Fatalf("inner hits: want errA and errB, got %v / %v", results[0], results[2])
	}
	// The shared outer rule is one-shot: exactly one of the two
	// fallthrough checks consumed it, the other observed exhaustion.
	outerHits := 0
	for _, err := range []error{results[1], results[3]} {
		if errors.Is(err, errOuter) {
			outerHits++
		} else if err != nil {
			t.Fatalf("unexpected fallthrough error: %v", err)
		}
	}
	if outerHits != 1 {
		t.Fatalf("shared outer rule fired %d times, want 1", outerHits)
	}
	if got := inj.Ledger().Len(); got != 3 {
		t.Fatalf("ledger: want 3 hits, got %d", got)
	}
}

// The ledger accounts for every actual hit, in order, with rule and scope.
func TestLedgerAccounting(t *testing.T) {
	inj := faultinj.New()
	r1 := faultinj.NewRule("r1", errA, faultinj.MatchOp("db"))
	r2 := faultinj.NewRule("r2", errB, faultinj.MatchOp("db"))

	ctx, exit1 := inj.WithScope(context.Background(), "layer-1", r1)
	defer exit1()
	ctx, exit2 := inj.WithScope(ctx, "layer-2", r2)
	defer exit2()

	_ = inj.Check(ctx, faultinj.Op("db"))
	_ = inj.Check(ctx, faultinj.Op("db"))

	hits := inj.Ledger().Hits()
	if len(hits) != 2 {
		t.Fatalf("want 2 hits, got %d", len(hits))
	}
	if hits[0].Seq != 1 || hits[1].Seq != 2 {
		t.Fatalf("hit seq out of order: %d, %d", hits[0].Seq, hits[1].Seq)
	}
	if hits[0].Rule != "r2" || hits[0].Scope != "layer-2" {
		t.Fatalf("first hit should be inner rule r2 in layer-2, got %+v", hits[0])
	}
	if hits[1].Rule != "r1" || hits[1].Scope != "layer-1" {
		t.Fatalf("second hit should be outer rule r1 in layer-1, got %+v", hits[1])
	}

	report := inj.Ledger().Report()
	for _, want := range []string{"#1 scope=layer-2 rule=r2 op=db", "#2 scope=layer-1 rule=r1 op=db"} {
		if !strings.Contains(report, want) {
			t.Fatalf("report missing %q:\n%s", want, report)
		}
	}
}

// Attribute matchers select operations by their attributes.
func TestAttrMatcher(t *testing.T) {
	inj := faultinj.New()
	rule := faultinj.NewRule("pg-only", errA, faultinj.MatchAttr("db", "postgres"))
	ctx, exit := inj.WithScope(context.Background(), "s", rule)
	defer exit()

	if err := inj.Check(ctx, faultinj.Op("query").WithAttr("db", "mysql")); err != nil {
		t.Fatalf("mysql op: want nil, got %v", err)
	}
	if err := inj.Check(ctx, faultinj.Op("query").WithAttr("db", "postgres")); !errors.Is(err, errA) {
		t.Fatalf("postgres op: want errA, got %v", err)
	}
}

// Example of the intended usage pattern.
func Example() {
	inj := faultinj.New()
	boom := errors.New("boom")
	rule := faultinj.NewRule("db-down", boom, faultinj.MatchOp("db.read"))

	ctx, exit := inj.WithScope(context.Background(), "request", rule)
	defer exit()

	fmt.Println(inj.Check(ctx, faultinj.Op("db.read")))
	fmt.Println(inj.Check(ctx, faultinj.Op("db.read")))
	fmt.Print(inj.Ledger().Report())
	// Output:
	// boom
	// <nil>
	// #1 scope=request rule=db-down op=db.read
}
