package main

import (
	"math/rand"
	"reflect"
	"testing"
)

func coverProblem(days []int, tickets ...CoverTicket) CoverProblem {
	return CoverProblem{Days: days, Tickets: tickets}
}

func TestCoverBasic(t *testing.T) {
	p := coverProblem([]int{1, 2, 3, 4, 5},
		CoverTicket{ID: "A", Kind: "区间票", Price: 5, Days: []int{1, 2, 3}},
		CoverTicket{ID: "B", Kind: "单程票", Price: 4, Days: []int{3, 4, 5}},
		CoverTicket{ID: "C", Kind: "通票", Price: 3, Days: []int{1, 2, 3}},
		CoverTicket{ID: "D", Kind: "通票", Price: 3, Days: []int{3, 4, 5}},
	)
	cert, err := SolveCover(p)
	if err != nil {
		t.Fatal(err)
	}
	if cert.Cost != 6 || cert.Count != 2 || !reflect.DeepEqual(cert.TicketIDs, []string{"C", "D"}) {
		t.Fatalf("got %+v", cert)
	}
	want := map[int]string{1: "C", 2: "C", 3: "C", 4: "D", 5: "D"}
	if !reflect.DeepEqual(cert.DayCover, want) {
		t.Fatalf("DayCover = %v, want %v", cert.DayCover, want)
	}
	if err := VerifyCover(p, cert); err != nil {
		t.Fatal(err)
	}
}

func TestCoverTieBreakCount(t *testing.T) {
	// 费用相同,选票数更少者
	p := coverProblem([]int{1, 2},
		CoverTicket{ID: "A", Price: 4, Days: []int{1, 2}},
		CoverTicket{ID: "B", Price: 2, Days: []int{1}},
		CoverTicket{ID: "C", Price: 2, Days: []int{2}},
	)
	cert, err := SolveCover(p)
	if err != nil {
		t.Fatal(err)
	}
	if cert.Cost != 4 || !reflect.DeepEqual(cert.TicketIDs, []string{"A"}) {
		t.Fatalf("got %+v", cert)
	}
}

func TestCoverTieBreakIDs(t *testing.T) {
	// 费用与票数相同,选 ID 序列字典序最小者
	p := coverProblem([]int{1, 2},
		CoverTicket{ID: "A", Price: 2, Days: []int{1}},
		CoverTicket{ID: "B", Price: 2, Days: []int{2}},
		CoverTicket{ID: "C", Price: 2, Days: []int{1}},
		CoverTicket{ID: "D", Price: 2, Days: []int{2}},
	)
	cert, err := SolveCover(p)
	if err != nil {
		t.Fatal(err)
	}
	if cert.Cost != 4 || !reflect.DeepEqual(cert.TicketIDs, []string{"A", "B"}) {
		t.Fatalf("got %+v", cert)
	}
}

func TestCoverInfeasible(t *testing.T) {
	p := coverProblem([]int{1, 5},
		CoverTicket{ID: "A", Price: 1, Days: []int{1}},
	)
	if _, err := SolveCover(p); err == nil {
		t.Fatal("expected infeasible error")
	}
	if _, _, err := BruteForceCover(p); err == nil {
		t.Fatal("expected infeasible error from brute force")
	}
}

func TestCoverTooManyTickets(t *testing.T) {
	p := coverProblem([]int{1})
	for i := 0; i < 23; i++ {
		p.Tickets = append(p.Tickets, CoverTicket{ID: string(rune('A' + i)), Price: 1, Days: []int{1}})
	}
	if _, err := SolveCover(p); err == nil {
		t.Fatal("expected error for > 22 tickets")
	}
}

func TestVerifyCoverRejectsBadCerts(t *testing.T) {
	p := coverProblem([]int{1, 2},
		CoverTicket{ID: "A", Price: 4, Days: []int{1, 2}},
		CoverTicket{ID: "B", Price: 2, Days: []int{1}},
	)
	good, err := SolveCover(p)
	if err != nil {
		t.Fatal(err)
	}
	badCost := *good
	badCost.Cost = 999
	if err := VerifyCover(p, &badCost); err == nil {
		t.Fatal("expected cost mismatch error")
	}
	badCover := *good
	badCover.DayCover = map[int]string{1: "B", 2: "B"} // B 不覆盖第 2 天
	badCover.TicketIDs = []string{"A", "B"}
	badCover.Count = 2
	badCover.Cost = 6
	if err := VerifyCover(p, &badCover); err == nil {
		t.Fatal("expected coverage error")
	}
	dup := *good
	dup.TicketIDs = []string{"A", "A"}
	dup.Count = 2
	dup.Cost = 8
	if err := VerifyCover(p, &dup); err == nil {
		t.Fatal("expected duplicate purchase error")
	}
}

func TestCoverRandomVsBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for iter := 0; iter < 500; iter++ {
		d := 1 + rng.Intn(7)
		n := 1 + rng.Intn(9)
		days := make([]int, d)
		for i := range days {
			days[i] = i + 1
		}
		p := CoverProblem{Days: days}
		for j := 0; j < n; j++ {
			tk := CoverTicket{ID: string(rune('A' + j)), Price: 1 + rng.Intn(20)}
			for _, day := range days {
				if rng.Intn(100) < 40 {
					tk.Days = append(tk.Days, day)
				}
			}
			p.Tickets = append(p.Tickets, tk)
		}
		got, err1 := SolveCover(p)
		want, _, err2 := BruteForceCover(p)
		if (err1 == nil) != (err2 == nil) {
			t.Fatalf("iter %d: solver err=%v brute err=%v\n%+v", iter, err1, err2, p)
		}
		if err1 != nil {
			continue
		}
		if got.Cost != want.Cost || got.Count != want.Count || !reflect.DeepEqual(got.TicketIDs, want.TicketIDs) {
			t.Fatalf("iter %d mismatch:\nsolver %+v\nbrute  %+v\nproblem %+v", iter, got, want, p)
		}
		if err := VerifyCover(p, got); err != nil {
			t.Fatalf("iter %d cert invalid: %v", iter, err)
		}
	}
}

func TestCoverMaxTickets(t *testing.T) {
	// 22 种票的上界情形:每种票各覆盖一天,必须全部买下
	p := CoverProblem{}
	for i := 0; i < 22; i++ {
		p.Days = append(p.Days, i+1)
		p.Tickets = append(p.Tickets, CoverTicket{ID: string(rune('A' + i)), Price: i + 1, Days: []int{i + 1}})
	}
	cert, err := SolveCover(p)
	if err != nil {
		t.Fatal(err)
	}
	if cert.Count != 22 || cert.Cost != 22*23/2 {
		t.Fatalf("got %+v", cert)
	}
	if err := VerifyCover(p, cert); err != nil {
		t.Fatal(err)
	}
}
