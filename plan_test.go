package dataeng

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func okRun(context.Context) error { return nil }

func TestBuildBatches(t *testing.T) {
	rules := []Rule{
		{ID: "a", Run: okRun, Produces: []string{"ca"}},
		{ID: "b", Run: okRun, Produces: []string{"cb"}},
		{ID: "c", Run: okRun, DependsOn: []string{"a"}, Inputs: []string{"ca"}, Produces: []string{"cc"}},
		{ID: "d", Run: okRun, DependsOn: []string{"a", "b"}, Inputs: []string{"ca", "cb"}},
		{ID: "e", Run: okRun, DependsOn: []string{"c", "d"}, Inputs: []string{"cc"}},
	}
	plan, err := Build(rules, nil)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	got := plan.Batches()
	want := [][]string{{"a", "b"}, {"c", "d"}, {"e"}}
	if len(got) != len(want) {
		t.Fatalf("batches = %v, want %v", got, want)
	}
	for i := range want {
		if len(got[i]) != len(want[i]) {
			t.Fatalf("batches = %v, want %v", got, want)
		}
		for j := range want[i] {
			if got[i][j] != want[i][j] {
				t.Fatalf("batches = %v, want %v", got, want)
			}
		}
	}
}

func TestBuildMinimalCycle(t *testing.T) {
	rules := []Rule{
		{ID: "a", Run: okRun, DependsOn: []string{"e"}},
		{ID: "b", Run: okRun, DependsOn: []string{"a"}},
		{ID: "c", Run: okRun, DependsOn: []string{"b"}},
		{ID: "d", Run: okRun, DependsOn: []string{"c"}},
		{ID: "e", Run: okRun, DependsOn: []string{"d"}},
		// 更短的环 x -> y -> x
		{ID: "x", Run: okRun, DependsOn: []string{"y"}},
		{ID: "y", Run: okRun, DependsOn: []string{"x"}},
	}
	_, err := Build(rules, nil)
	var ce *CycleError
	if !errors.As(err, &ce) {
		t.Fatalf("expected CycleError, got %v", err)
	}
	if len(ce.Path) != 3 { // [x y x] 或 [y x y]
		t.Fatalf("cycle = %v, want minimal 2-node cycle", ce.Path)
	}
	if ce.Path[0] != ce.Path[len(ce.Path)-1] {
		t.Fatalf("cycle path not closed: %v", ce.Path)
	}
}

func TestBuildSelfLoop(t *testing.T) {
	_, err := Build([]Rule{{ID: "a", Run: okRun, DependsOn: []string{"a"}}}, nil)
	var ce *CycleError
	if !errors.As(err, &ce) {
		t.Fatalf("expected CycleError, got %v", err)
	}
	if len(ce.Path) != 2 || ce.Path[0] != "a" || ce.Path[1] != "a" {
		t.Fatalf("cycle = %v, want [a a]", ce.Path)
	}
}

func TestBuildValidation(t *testing.T) {
	cases := []struct {
		name  string
		rules []Rule
		base  []string
	}{
		{"duplicate id", []Rule{{ID: "a", Run: okRun}, {ID: "a", Run: okRun}}, nil},
		{"unknown dep", []Rule{{ID: "a", Run: okRun, DependsOn: []string{"ghost"}}}, nil},
		{"duplicate dep", []Rule{{ID: "a", Run: okRun}, {ID: "b", Run: okRun, DependsOn: []string{"a", "a"}}}, nil},
		{"nil run", []Rule{{ID: "a"}}, nil},
		{"column conflict", []Rule{
			{ID: "a", Run: okRun, Produces: []string{"c"}},
			{ID: "b", Run: okRun, Produces: []string{"c"}},
		}, nil},
		{"unavailable input", []Rule{{ID: "a", Run: okRun, Inputs: []string{"nope"}}}, nil},
		{"producer not a dependency", []Rule{
			{ID: "a", Run: okRun, Produces: []string{"c"}},
			{ID: "b", Run: okRun, Inputs: []string{"c"}},
		}, nil},
		{"reads own derived column", []Rule{
			{ID: "a", Run: okRun, Inputs: []string{"c"}, Produces: []string{"c"}},
		}, nil},
		{"base column ok", []Rule{{ID: "a", Run: okRun, Inputs: []string{"raw"}}}, []string{"raw"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Build(tc.rules, tc.base)
			if tc.name == "base column ok" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			var ve *ValidationError
			if !errors.As(err, &ve) {
				t.Fatalf("expected ValidationError, got %v", err)
			}
		})
	}
}

func TestExecuteStableOrderAndParallel(t *testing.T) {
	var inFlight atomic.Int32
	var maxSeen atomic.Int32
	slow := func(context.Context) error {
		cur := inFlight.Add(1)
		for {
			old := maxSeen.Load()
			if cur <= old || maxSeen.CompareAndSwap(old, cur) {
				break
			}
		}
		time.Sleep(50 * time.Millisecond)
		inFlight.Add(-1)
		return nil
	}
	// 声明顺序故意与完成顺序无关；c 依赖 a。
	rules := []Rule{
		{ID: "a", Run: slow},
		{ID: "b", Run: slow},
		{ID: "c", Run: okRun, DependsOn: []string{"a"}},
	}
	plan, err := Build(rules, nil)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	results := plan.Execute(context.Background())
	if maxSeen.Load() < 2 {
		t.Fatalf("batch not parallel, max concurrency = %d", maxSeen.Load())
	}
	wantOrder := []string{"a", "b", "c"}
	for i, r := range results {
		if r.RuleID != wantOrder[i] {
			t.Fatalf("results order = %v, want %v", results, wantOrder)
		}
		if r.Status != StatusPassed || !r.Passed() {
			t.Fatalf("rule %s status = %v", r.RuleID, r.Status)
		}
	}
}

func TestExecuteSkipPolicy(t *testing.T) {
	boom := errors.New("boom")
	fail := func(context.Context) error { return boom }
	ran := make(map[string]bool)
	var mu sync.Mutex
	mark := func(id string) func(context.Context) error {
		return func(context.Context) error {
			mu.Lock()
			ran[id] = true
			mu.Unlock()
			return nil
		}
	}
	rules := []Rule{
		{ID: "bad", Run: fail},
		{ID: "child", Run: mark("child"), DependsOn: []string{"bad"}},
		{ID: "grandchild", Run: mark("grandchild"), DependsOn: []string{"child"}},
		{ID: "brave", Run: mark("brave"), DependsOn: []string{"bad"}, OnDepFailure: ContinueOnDepFailure},
	}
	plan, err := Build(rules, nil)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	results := plan.Execute(context.Background())
	byID := make(map[string]Result)
	for _, r := range results {
		byID[r.RuleID] = r
	}
	if byID["bad"].Status != StatusFailed {
		t.Fatalf("bad = %v, want failed", byID["bad"].Status)
	}
	if byID["child"].Status != StatusSkipped {
		t.Fatalf("child = %v, want skipped", byID["child"].Status)
	}
	if !errors.Is(byID["child"].Err, ErrDependencyNotPassed) {
		t.Fatalf("child err = %v, want ErrDependencyNotPassed", byID["child"].Err)
	}
	// 被跳过的规则不能被当作通过，且继续阻断下游。
	if byID["child"].Passed() {
		t.Fatal("skipped rule must not pass")
	}
	if byID["grandchild"].Status != StatusSkipped {
		t.Fatalf("grandchild = %v, want skipped (skip of skipped)", byID["grandchild"].Status)
	}
	if byID["brave"].Status != StatusPassed {
		t.Fatalf("brave = %v, want passed (continue policy)", byID["brave"].Status)
	}
	if ran["child"] || ran["grandchild"] {
		t.Fatal("skipped rules must not execute")
	}
	if !ran["brave"] {
		t.Fatal("continue-policy rule should execute")
	}
}
