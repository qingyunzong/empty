package solver

import (
	"math/rand"
	"reflect"
	"testing"
)

func TestSolveCoverPrefersCheaperSingleTicket(t *testing.T) {
	days := []int{1, 2, 3}
	tickets := []CoverTicket{
		{ID: "A", Cost: 5, Days: []int{1, 2}},
		{ID: "B", Cost: 5, Days: []int{2, 3}},
		{ID: "C", Cost: 9, Days: []int{1, 2, 3}},
	}
	sol, err := SolveCover(days, tickets)
	if err != nil {
		t.Fatal(err)
	}
	if sol.Cost != 9 || sol.Count != 1 || !reflect.DeepEqual(sol.IDs, []string{"C"}) {
		t.Fatalf("got %+v", sol)
	}
	if err := CheckCoverCertificate(days, tickets, sol); err != nil {
		t.Fatal(err)
	}
}

func TestSolveCoverTieBreaksByCount(t *testing.T) {
	days := []int{1, 2}
	tickets := []CoverTicket{
		{ID: "A", Cost: 6, Days: []int{1}},
		{ID: "B", Cost: 6, Days: []int{2}},
		{ID: "C", Cost: 12, Days: []int{1, 2}},
	}
	sol, err := SolveCover(days, tickets)
	if err != nil {
		t.Fatal(err)
	}
	// Cost 12 is achievable with one ticket (C) or two (A+B): fewer wins.
	if sol.Cost != 12 || sol.Count != 1 || !reflect.DeepEqual(sol.IDs, []string{"C"}) {
		t.Fatalf("got %+v", sol)
	}
}

func TestSolveCoverTieBreaksByIDs(t *testing.T) {
	days := []int{1, 2, 3}
	tickets := []CoverTicket{
		{ID: "B", Cost: 5, Days: []int{1, 2}},
		{ID: "C", Cost: 5, Days: []int{2, 3}},
		{ID: "A", Cost: 5, Days: []int{1, 2}},
		{ID: "D", Cost: 5, Days: []int{2, 3}},
	}
	sol, err := SolveCover(days, tickets)
	if err != nil {
		t.Fatal(err)
	}
	// Both {A,C} and {B,C} cost 10 with 2 tickets; {A,C} is lexicographically
	// smaller. {A,D} is not: compare [A,C] vs [A,D].
	if sol.Cost != 10 || sol.Count != 2 || !reflect.DeepEqual(sol.IDs, []string{"A", "C"}) {
		t.Fatalf("got %+v", sol)
	}
}

func TestSolveCoverInfeasible(t *testing.T) {
	_, err := SolveCover([]int{1, 5}, []CoverTicket{{ID: "A", Cost: 1, Days: []int{1}}})
	if err == nil {
		t.Fatal("expected infeasible error")
	}
}

func TestSolveCoverTooManyTickets(t *testing.T) {
	tickets := make([]CoverTicket, MaxTickets+1)
	for i := range tickets {
		tickets[i] = CoverTicket{ID: string(rune('A' + i)), Cost: 1, Days: []int{1}}
	}
	if _, err := SolveCover([]int{1}, tickets); err == nil {
		t.Fatal("expected too-many-tickets error")
	}
}

func TestCheckCoverCertificateRejectsTampering(t *testing.T) {
	days := []int{1, 2}
	tickets := []CoverTicket{
		{ID: "A", Cost: 3, Days: []int{1}},
		{ID: "B", Cost: 4, Days: []int{2}},
	}
	sol, err := SolveCover(days, tickets)
	if err != nil {
		t.Fatal(err)
	}
	// Understate the cost.
	bad := *sol
	bad.Cost = 1
	if err := CheckCoverCertificate(days, tickets, &bad); err == nil {
		t.Fatal("expected cost mismatch to be rejected")
	}
	// Certify a day with a ticket that does not cover it.
	bad2 := *sol
	bad2.Coverage = []DayCover{{Day: 1, TicketID: "A"}, {Day: 2, TicketID: "A"}}
	if err := CheckCoverCertificate(days, tickets, &bad2); err == nil {
		t.Fatal("expected wrong coverage to be rejected")
	}
	// Drop a day.
	bad3 := *sol
	bad3.Coverage = sol.Coverage[:1]
	if err := CheckCoverCertificate(days, tickets, &bad3); err == nil {
		t.Fatal("expected missing day to be rejected")
	}
}

func TestCoverMatchesBruteForceRandom(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for iter := 0; iter < 300; iter++ {
		d := 1 + rng.Intn(8)
		days := make([]int, d)
		for i := range days {
			days[i] = i + 1
		}
		n := 1 + rng.Intn(10)
		tickets := make([]CoverTicket, n)
		for i := range tickets {
			var td []int
			for _, day := range days {
				if rng.Intn(2) == 0 {
					td = append(td, day)
				}
			}
			tickets[i] = CoverTicket{
				ID:   string(rune('A' + i)),
				Cost: rng.Intn(20),
				Days: td,
			}
		}
		sol, errSolve := SolveCover(days, tickets)
		bf, errBF := BruteForceCover(days, tickets)
		if (errSolve == nil) != (errBF == nil) {
			t.Fatalf("iter %d: solver err=%v brute err=%v", iter, errSolve, errBF)
		}
		if errSolve != nil {
			continue
		}
		if !SameOptimum(sol.Cost, sol.Count, sol.IDs, bf.Cost, bf.Count, bf.IDs) {
			t.Fatalf("iter %d: solver (%d,%d,%v) != brute (%d,%d,%v)",
				iter, sol.Cost, sol.Count, sol.IDs, bf.Cost, bf.Count, bf.IDs)
		}
		if err := CheckCoverCertificate(days, tickets, sol); err != nil {
			t.Fatalf("iter %d: %v", iter, err)
		}
	}
}

func TestSolveCoverMaxTickets(t *testing.T) {
	// 22 ticket types, 30 days: exercises the full allowed size.
	days := make([]int, 30)
	for i := range days {
		days[i] = i + 1
	}
	tickets := make([]CoverTicket, MaxTickets)
	for i := range tickets {
		tickets[i] = CoverTicket{
			ID:   string(rune('A' + i)),
			Cost: 1 + i,
			Days: []int{days[i], days[(i+9)%30]},
		}
	}
	sol, err := SolveCover(days, tickets)
	if err != nil {
		t.Fatal(err)
	}
	if err := CheckCoverCertificate(days, tickets, sol); err != nil {
		t.Fatal(err)
	}
	bf, err := BruteForceCover(days, tickets)
	if err != nil {
		t.Fatal(err)
	}
	if !SameOptimum(sol.Cost, sol.Count, sol.IDs, bf.Cost, bf.Count, bf.IDs) {
		t.Fatalf("solver (%d,%d,%v) != brute (%d,%d,%v)",
			sol.Cost, sol.Count, sol.IDs, bf.Cost, bf.Count, bf.IDs)
	}
}
