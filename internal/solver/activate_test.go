package solver

import (
	"math/rand"
	"reflect"
	"testing"
)

func TestSolveActivatePassBeatsSingles(t *testing.T) {
	days := []int{1, 2, 3}
	tickets := []ActTicket{
		{ID: "S", Cost: 4, Validity: 1, Cap: 1},
		{ID: "P", Cost: 10, Validity: 3, Cap: 3},
	}
	sol, err := SolveActivate(days, tickets)
	if err != nil {
		t.Fatal(err)
	}
	if sol.Cost != 10 || sol.Count != 1 || !reflect.DeepEqual(sol.IDs, []string{"P"}) {
		t.Fatalf("got %+v", sol)
	}
	if sol.Purchases[0].ActivationDay != 1 || len(sol.Purchases[0].UsedDays) != 3 {
		t.Fatalf("bad purchases %+v", sol.Purchases)
	}
	if err := CheckActCertificate(days, tickets, sol); err != nil {
		t.Fatal(err)
	}
}

func TestSolveActivateCapForcesExtraTickets(t *testing.T) {
	days := []int{1, 2, 3}
	tickets := []ActTicket{
		{ID: "P", Cost: 6, Validity: 3, Cap: 1}, // covers only one day
		{ID: "S1", Cost: 4, Validity: 1, Cap: 1},
		{ID: "S2", Cost: 4, Validity: 1, Cap: 1},
		{ID: "S3", Cost: 4, Validity: 1, Cap: 1},
	}
	sol, err := SolveActivate(days, tickets)
	if err != nil {
		t.Fatal(err)
	}
	// P plus two singles costs 14 and loses to three singles at 12. Each
	// ticket type can be bought at most once.
	if sol.Cost != 12 || sol.Count != 3 || !reflect.DeepEqual(sol.IDs, []string{"S1", "S2", "S3"}) {
		t.Fatalf("got %+v", sol)
	}
}

func TestSolveActivateWindowForcesExtraPurchases(t *testing.T) {
	days := []int{1, 5, 9}
	tickets := []ActTicket{
		{ID: "P1", Cost: 7, Validity: 3, Cap: 3},
		{ID: "P2", Cost: 7, Validity: 3, Cap: 3},
		{ID: "P3", Cost: 7, Validity: 3, Cap: 3},
		{ID: "S1", Cost: 8, Validity: 1, Cap: 1},
		{ID: "S2", Cost: 8, Validity: 1, Cap: 1},
		{ID: "S3", Cost: 8, Validity: 1, Cap: 1},
	}
	sol, err := SolveActivate(days, tickets)
	if err != nil {
		t.Fatal(err)
	}
	// Three passes (21) beat three singles (24); each pass activates on its
	// own day because the validity window is only 3 days.
	if sol.Cost != 21 || sol.Count != 3 {
		t.Fatalf("got %+v", sol)
	}
	for i, p := range sol.Purchases {
		if p.ActivationDay != days[i] || len(p.UsedDays) != 1 {
			t.Fatalf("bad purchase %+v", p)
		}
	}
	if err := CheckActCertificate(days, tickets, sol); err != nil {
		t.Fatal(err)
	}
}

func TestSolveActivateTieBreaksByIDs(t *testing.T) {
	days := []int{1, 2}
	tickets := []ActTicket{
		{ID: "B", Cost: 5, Validity: 2, Cap: 2},
		{ID: "A", Cost: 5, Validity: 2, Cap: 2},
	}
	sol, err := SolveActivate(days, tickets)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(sol.IDs, []string{"A"}) {
		t.Fatalf("got %+v", sol)
	}
}

func TestSolveActivateInfeasible(t *testing.T) {
	// One ticket, cap 1, two travel days: cannot cover both.
	_, err := SolveActivate([]int{1, 2}, []ActTicket{{ID: "S", Cost: 1, Validity: 1, Cap: 1}})
	if err == nil {
		t.Fatal("expected infeasible error")
	}
}

func TestCheckActCertificateRejectsTampering(t *testing.T) {
	days := []int{1, 2, 3}
	tickets := []ActTicket{{ID: "P", Cost: 10, Validity: 3, Cap: 3}}
	sol, err := SolveActivate(days, tickets)
	if err != nil {
		t.Fatal(err)
	}
	// Wrong activation day.
	bad := *sol
	bad.Purchases = []Purchase{{ID: "P", ActivationDay: 2, UsedDays: []int{1, 2, 3}}}
	if err := CheckActCertificate(days, tickets, &bad); err == nil {
		t.Fatal("expected activation mismatch to be rejected")
	}
	// Use beyond validity window.
	bad2 := *sol
	bad2.Purchases = []Purchase{{ID: "P", ActivationDay: 1, UsedDays: []int{1, 2, 3}}}
	bad2.Daily = append(append([]DayUse{}, sol.Daily...), DayUse{Day: 4, TicketID: "P"})
	if err := CheckActCertificate([]int{1, 2, 3, 4}, tickets, &bad2); err == nil {
		t.Fatal("expected validity violation to be rejected")
	}
	// Unpurchased ticket used.
	bad3 := *sol
	bad3.Daily = append(append([]DayUse{}, sol.Daily...), DayUse{Day: 4, TicketID: "X"})
	if err := CheckActCertificate([]int{1, 2, 3, 4}, tickets, &bad3); err == nil {
		t.Fatal("expected unpurchased ticket to be rejected")
	}
}

func TestActivateMatchesBruteForceRandom(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for iter := 0; iter < 300; iter++ {
		d := 1 + rng.Intn(6)
		var days []int
		day := 1
		for len(days) < d {
			days = append(days, day)
			day += 1 + rng.Intn(3)
		}
		n := 1 + rng.Intn(6)
		tickets := make([]ActTicket, n)
		for i := range tickets {
			validity := 1 + rng.Intn(4)
			tickets[i] = ActTicket{
				ID:       string(rune('A' + i)),
				Cost:     rng.Intn(20),
				Validity: validity,
				Cap:      1 + rng.Intn(validity+1),
			}
		}
		sol, errSolve := SolveActivate(days, tickets)
		bf, errBF := BruteForceActivate(days, tickets)
		if (errSolve == nil) != (errBF == nil) {
			t.Fatalf("iter %d: solver err=%v brute err=%v (days=%v tickets=%+v)",
				iter, errSolve, errBF, days, tickets)
		}
		if errSolve != nil {
			continue
		}
		if !SameOptimum(sol.Cost, sol.Count, sol.IDs, bf.Cost, bf.Count, bf.IDs) {
			t.Fatalf("iter %d: solver (%d,%d,%v) != brute (%d,%d,%v) (days=%v tickets=%+v)",
				iter, sol.Cost, sol.Count, sol.IDs, bf.Cost, bf.Count, bf.IDs, days, tickets)
		}
		if err := CheckActCertificate(days, tickets, sol); err != nil {
			t.Fatalf("iter %d: %v", iter, err)
		}
		if err := CheckActCertificate(days, tickets, bf); err != nil {
			t.Fatalf("iter %d: brute certificate: %v", iter, err)
		}
	}
}

func TestBruteForceActivateTooLarge(t *testing.T) {
	days := make([]int, 10)
	for i := range days {
		days[i] = i + 1
	}
	tickets := make([]ActTicket, 12)
	for i := range tickets {
		tickets[i] = ActTicket{ID: string(rune('A' + i)), Cost: 1, Validity: 3, Cap: 2}
	}
	if _, err := BruteForceActivate(days, tickets); err != ErrTooLarge {
		t.Fatalf("expected ErrTooLarge, got %v", err)
	}
}
