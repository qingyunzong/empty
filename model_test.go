package protocheck

import (
	"reflect"
	"testing"
)

func doorTable() *Table {
	return &Table{
		Initial: "closed",
		States:  []string{"closed", "open", "locked"},
		Transitions: []Transition{
			{Action: "open", From: "closed", To: "open"},
			{Action: "close", From: "open", To: "closed"},
			{Action: "lock", From: "closed", To: "locked"},
			{Action: "unlock", From: "locked", To: "closed"},
		},
	}
}

func TestValidateOK(t *testing.T) {
	if err := doorTable().Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
}

func TestValidateRejectsBadTables(t *testing.T) {
	base := doorTable()

	dup := *base
	dup.Transitions = append(append([]Transition{}, base.Transitions...),
		Transition{Action: "open", From: "closed", To: "locked"})
	if err := dup.Validate(); err == nil {
		t.Fatal("expected duplicate transition error")
	}

	badFrom := *base
	badFrom.Transitions = append(append([]Transition{}, base.Transitions...),
		Transition{Action: "x", From: "nowhere", To: "closed"})
	if err := badFrom.Validate(); err == nil {
		t.Fatal("expected unknown from-state error")
	}

	badInitial := *base
	badInitial.Initial = "nowhere"
	if err := badInitial.Validate(); err == nil {
		t.Fatal("expected unknown initial state error")
	}
}

func TestGenerateHistories(t *testing.T) {
	got := doorTable().GenerateHistories(2)
	want := [][]string{
		{},
		{"lock"},
		{"open"},
		{"lock", "unlock"},
		{"open", "close"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("GenerateHistories(2) = %v, want %v", got, want)
	}
}

func TestGenerateHistoriesZeroBudget(t *testing.T) {
	got := doorTable().GenerateHistories(0)
	if len(got) != 1 || len(got[0]) != 0 {
		t.Fatalf("GenerateHistories(0) = %v, want [[]]", got)
	}
}

func TestLegalActionsAndAlphabet(t *testing.T) {
	tab := doorTable()
	if got := tab.LegalActions("closed"); !reflect.DeepEqual(got, []string{"lock", "open"}) {
		t.Fatalf("LegalActions(closed) = %v", got)
	}
	if got := tab.Actions(); !reflect.DeepEqual(got, []string{"close", "lock", "open", "unlock"}) {
		t.Fatalf("Actions() = %v", got)
	}
}
