package main

import (
	"math/rand"
	"reflect"
	"testing"
)

func TestActivateBasic(t *testing.T) {
	// A 第 1 天激活,有效期覆盖第 1、2 天;第 4 天超出 A 的有效期,需 B。
	p := ActProblem{
		Days: []int{1, 2, 4},
		Tickets: []ActTicket{
			{ID: "A", Price: 10, ValidDays: 2, MaxUses: 2},
			{ID: "B", Price: 6, ValidDays: 1, MaxUses: 1},
		},
	}
	cert, err := SolveActivate(p)
	if err != nil {
		t.Fatal(err)
	}
	if cert.Cost != 16 || cert.Count != 2 || !reflect.DeepEqual(cert.TicketIDs, []string{"A", "B"}) {
		t.Fatalf("got %+v", cert)
	}
	if cert.ActivateOn["A"] != 1 || cert.ActivateOn["B"] != 4 {
		t.Fatalf("ActivateOn = %v", cert.ActivateOn)
	}
	want := map[int]string{1: "A", 2: "A", 4: "B"}
	if !reflect.DeepEqual(cert.DayUse, want) {
		t.Fatalf("DayUse = %v, want %v", cert.DayUse, want)
	}
	if err := VerifyActivate(p, cert); err != nil {
		t.Fatal(err)
	}
}

func TestActivateCapForcesSecondTicket(t *testing.T) {
	// A 便宜但覆盖上限只有 2,3 天行程必须再购票;B 一张即可覆盖 3 天。
	p := ActProblem{
		Days: []int{1, 2, 3},
		Tickets: []ActTicket{
			{ID: "A", Price: 4, ValidDays: 3, MaxUses: 2},
			{ID: "B", Price: 6, ValidDays: 3, MaxUses: 3},
		},
	}
	cert, err := SolveActivate(p)
	if err != nil {
		t.Fatal(err)
	}
	if cert.Cost != 6 || !reflect.DeepEqual(cert.TicketIDs, []string{"B"}) {
		t.Fatalf("got %+v", cert)
	}
}

func TestActivateWindowForcesSecondTicket(t *testing.T) {
	// A 有效期 2 天,第 3 天必须靠 B。
	p := ActProblem{
		Days: []int{1, 2, 3},
		Tickets: []ActTicket{
			{ID: "A", Price: 4, ValidDays: 2, MaxUses: 3},
			{ID: "B", Price: 3, ValidDays: 1, MaxUses: 1},
		},
	}
	cert, err := SolveActivate(p)
	if err != nil {
		t.Fatal(err)
	}
	if cert.Cost != 7 || !reflect.DeepEqual(cert.TicketIDs, []string{"A", "B"}) {
		t.Fatalf("got %+v", cert)
	}
	if cert.DayUse[3] != "B" || cert.ActivateOn["B"] != 3 {
		t.Fatalf("got %+v", cert)
	}
}

func TestActivateTieBreakIDs(t *testing.T) {
	// 两张票完全等价,选 ID 更小者
	p := ActProblem{
		Days: []int{1},
		Tickets: []ActTicket{
			{ID: "B", Price: 5, ValidDays: 1, MaxUses: 1},
			{ID: "A", Price: 5, ValidDays: 1, MaxUses: 1},
		},
	}
	cert, err := SolveActivate(p)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(cert.TicketIDs, []string{"A"}) {
		t.Fatalf("got %+v", cert)
	}
}

func TestActivateInfeasible(t *testing.T) {
	p := ActProblem{
		Days:    []int{1, 2, 3},
		Tickets: []ActTicket{{ID: "A", Price: 1, ValidDays: 1, MaxUses: 1}},
	}
	if _, err := SolveActivate(p); err == nil {
		t.Fatal("expected infeasible error")
	}
	if _, _, err := BruteForceActivate(p); err == nil {
		t.Fatal("expected infeasible error from brute force")
	}
}

func TestVerifyActivateRejectsBadCerts(t *testing.T) {
	p := ActProblem{
		Days: []int{1, 2, 4},
		Tickets: []ActTicket{
			{ID: "A", Price: 10, ValidDays: 2, MaxUses: 2},
			{ID: "B", Price: 6, ValidDays: 1, MaxUses: 1},
		},
	}
	good, err := SolveActivate(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyActivate(p, good); err != nil {
		t.Fatal(err)
	}
	badCost := *good
	badCost.Cost = 1
	if err := VerifyActivate(p, &badCost); err == nil {
		t.Fatal("expected cost mismatch error")
	}
	badAct := *good
	badAct.ActivateOn = map[string]int{"A": 2, "B": 4} // A 激活日应为 1
	if err := VerifyActivate(p, &badAct); err == nil {
		t.Fatal("expected activation day error")
	}
	badUse := *good
	badUse.DayUse = map[int]string{1: "A", 2: "A", 4: "A"} // 超出 A 的有效期
	badUse.TicketIDs = []string{"A"}
	badUse.Count = 1
	badUse.Cost = 10
	badUse.ActivateOn = map[string]int{"A": 1}
	if err := VerifyActivate(p, &badUse); err == nil {
		t.Fatal("expected validity window error")
	}
	badCap := *good
	badCap.DayUse = map[int]string{1: "B", 2: "B", 4: "B"} // 超出 B 的覆盖上限
	badCap.TicketIDs = []string{"B"}
	badCap.Count = 1
	badCap.Cost = 6
	badCap.ActivateOn = map[string]int{"B": 1}
	if err := VerifyActivate(p, &badCap); err == nil {
		t.Fatal("expected max uses error")
	}
}

func TestActivateRandomVsBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for iter := 0; iter < 400; iter++ {
		d := 1 + rng.Intn(5)
		n := 1 + rng.Intn(5)
		days := make([]int, d)
		day := 1
		for i := range days {
			day += rng.Intn(3) // 允许日期间隔,制造有效期窗口压力
			days[i] = day
		}
		p := ActProblem{Days: days}
		for j := 0; j < n; j++ {
			p.Tickets = append(p.Tickets, ActTicket{
				ID:        string(rune('A' + j)),
				Price:     1 + rng.Intn(15),
				ValidDays: 1 + rng.Intn(4),
				MaxUses:   1 + rng.Intn(3),
			})
		}
		got, err1 := SolveActivate(p)
		want, _, err2 := BruteForceActivate(p)
		if (err1 == nil) != (err2 == nil) {
			t.Fatalf("iter %d: solver err=%v brute err=%v\n%+v", iter, err1, err2, p)
		}
		if err1 != nil {
			continue
		}
		if got.Cost != want.Cost || got.Count != want.Count || !reflect.DeepEqual(got.TicketIDs, want.TicketIDs) {
			t.Fatalf("iter %d mismatch:\nsolver %+v\nbrute  %+v\nproblem %+v", iter, got, want, p)
		}
		if err := VerifyActivate(p, got); err != nil {
			t.Fatalf("iter %d cert invalid: %v\n%+v", iter, err, got)
		}
	}
}
