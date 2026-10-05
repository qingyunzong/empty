package sched

import (
	"math/rand"
	"reflect"
	"testing"
)

func TestFeasible(t *testing.T) {
	cases := []struct {
		name  string
		tasks []Task
		want  bool
	}{
		{"empty", nil, true},
		{"single fits", []Task{{ID: 1, Release: 0, Deadline: 1, Profit: 5}}, true},
		{"single misses", []Task{{ID: 1, Release: 2, Deadline: 2, Profit: 5}}, false},
		{"two share one slot", []Task{
			{ID: 1, Release: 0, Deadline: 1, Profit: 1},
			{ID: 2, Release: 0, Deadline: 1, Profit: 1},
		}, false},
		{"release forces order", []Task{
			{ID: 1, Release: 1, Deadline: 2, Profit: 1},
			{ID: 2, Release: 0, Deadline: 2, Profit: 1},
		}, true},
		{"nested windows", []Task{
			{ID: 1, Release: 0, Deadline: 3, Profit: 1},
			{ID: 2, Release: 1, Deadline: 2, Profit: 1},
			{ID: 3, Release: 0, Deadline: 1, Profit: 1},
		}, true},
		{"overpacked", []Task{
			{ID: 1, Release: 0, Deadline: 2, Profit: 1},
			{ID: 2, Release: 0, Deadline: 2, Profit: 1},
			{ID: 3, Release: 0, Deadline: 2, Profit: 1},
		}, false},
	}
	for _, c := range cases {
		if got := feasible(c.tasks); got != c.want {
			t.Errorf("%s: feasible = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestSolveSimple(t *testing.T) {
	tasks := []Task{
		{ID: 1, Release: 0, Deadline: 2, Profit: 10},
		{ID: 2, Release: 0, Deadline: 2, Profit: 9},
		{ID: 3, Release: 1, Deadline: 3, Profit: 8},
	}
	sol, err := Solve(tasks)
	if err != nil {
		t.Fatal(err)
	}
	if sol.Profit != 27 {
		t.Errorf("profit = %d, want 27", sol.Profit)
	}
	if !reflect.DeepEqual(sol.Order, []int{1, 2, 3}) {
		t.Errorf("order = %v, want [1 2 3]", sol.Order)
	}
	wantSlots := map[int]int{1: 0, 2: 1, 3: 2}
	if !reflect.DeepEqual(sol.Slots, wantSlots) {
		t.Errorf("slots = %v, want %v", sol.Slots, wantSlots)
	}
	if err := sol.Verify(); err != nil {
		t.Errorf("certificate invalid: %v", err)
	}
}

func TestSolveDropsUnprofitable(t *testing.T) {
	tasks := []Task{
		{ID: 1, Release: 0, Deadline: 1, Profit: 10},
		{ID: 2, Release: 0, Deadline: 1, Profit: 9},
	}
	sol, err := Solve(tasks)
	if err != nil {
		t.Fatal(err)
	}
	if sol.Profit != 10 || !reflect.DeepEqual(sol.Order, []int{1}) {
		t.Errorf("got profit=%d order=%v, want profit=10 order=[1]", sol.Profit, sol.Order)
	}
}

func TestTieBreakSmallestID(t *testing.T) {
	// Two tasks compete for the single slot 0 with equal profit:
	// the smaller task ID must win.
	tasks := []Task{
		{ID: 5, Release: 0, Deadline: 1, Profit: 10},
		{ID: 1, Release: 0, Deadline: 1, Profit: 10},
	}
	sol, err := Solve(tasks)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(sol.Order, []int{1}) {
		t.Errorf("order = %v, want [1]", sol.Order)
	}
}

func TestTieBreakPrefixBeatsExtension(t *testing.T) {
	// {1} and {1,2} both yield profit 10; the shorter prefix [1] wins.
	tasks := []Task{
		{ID: 1, Release: 0, Deadline: 2, Profit: 10},
		{ID: 2, Release: 1, Deadline: 2, Profit: 0},
	}
	sol, err := Solve(tasks)
	if err != nil {
		t.Fatal(err)
	}
	if sol.Profit != 10 || !reflect.DeepEqual(sol.Order, []int{1}) {
		t.Errorf("got profit=%d order=%v, want profit=10 order=[1]", sol.Profit, sol.Order)
	}
}

func TestTieBreakExecutionOrder(t *testing.T) {
	// Subset {1,2,3} is the unique profit maximum but admits two
	// execution orders; [1 3 2] is not feasible, so [1 2 3]... here
	// instead force a real choice: both [1 2] and [2 1] feasible.
	tasks := []Task{
		{ID: 2, Release: 0, Deadline: 2, Profit: 5},
		{ID: 1, Release: 0, Deadline: 2, Profit: 5},
	}
	sol, err := Solve(tasks)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(sol.Order, []int{1, 2}) {
		t.Errorf("order = %v, want [1 2]", sol.Order)
	}
	if sol.Slots[1] != 0 || sol.Slots[2] != 1 {
		t.Errorf("slots = %v, want task1@0 task2@1", sol.Slots)
	}
}

func TestSolveRejectsTooManyTasks(t *testing.T) {
	tasks := make([]Task, MaxTasks+1)
	for i := range tasks {
		tasks[i] = Task{ID: i, Release: 0, Deadline: 1, Profit: 1}
	}
	if _, err := Solve(tasks); err == nil {
		t.Error("expected error for more than MaxTasks tasks")
	}
}

func TestSolveRejectsDuplicateIDs(t *testing.T) {
	tasks := []Task{
		{ID: 1, Release: 0, Deadline: 1, Profit: 1},
		{ID: 1, Release: 0, Deadline: 2, Profit: 2},
	}
	if _, err := Solve(tasks); err == nil {
		t.Error("expected error for duplicate IDs")
	}
}

// TestCrossCheckBruteForce compares Solve against exhaustive enumeration
// of all sequences on many random small instances.
func TestCrossCheckBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for trial := 0; trial < 400; trial++ {
		n := rng.Intn(9) // 0..8 tasks
		tasks := make([]Task, n)
		for i := range tasks {
			r := rng.Intn(6)
			tasks[i] = Task{
				ID:       i + 1,
				Release:  r,
				Deadline: r + 1 + rng.Intn(6),
				Profit:   int64(rng.Intn(21)),
			}
		}
		sol, err := Solve(tasks)
		if err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		brute := BruteForce(tasks)
		if sol.Profit != brute.Profit {
			t.Fatalf("trial %d: profit %d != brute %d for %v",
				trial, sol.Profit, brute.Profit, tasks)
		}
		if !reflect.DeepEqual(sol.Order, brute.Order) {
			t.Fatalf("trial %d: order %v != brute %v for %v",
				trial, sol.Order, brute.Order, tasks)
		}
		if err := sol.Verify(); err != nil {
			t.Fatalf("trial %d: invalid certificate: %v", trial, err)
		}
	}
}

// TestSolveMaxSize ensures the 18-task path stays correct and fast.
func TestSolveMaxSize(t *testing.T) {
	rng := rand.New(rand.NewSource(18))
	tasks := make([]Task, MaxTasks)
	for i := range tasks {
		r := rng.Intn(10)
		tasks[i] = Task{
			ID:       i + 1,
			Release:  r,
			Deadline: r + 1 + rng.Intn(10),
			Profit:   int64(1 + rng.Intn(50)),
		}
	}
	sol, err := Solve(tasks)
	if err != nil {
		t.Fatal(err)
	}
	if err := sol.Verify(); err != nil {
		t.Fatalf("invalid certificate: %v", err)
	}
}
