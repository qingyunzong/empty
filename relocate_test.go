package dataeng

import (
	"errors"
	"math"
	"testing"
)

func newRelocationTarget(t *testing.T) (*Context, Directory) {
	t.Helper()
	directory := Directory{
		Key{"shared", 1}: []Slot{UnknownSlot(), KnownSlot("x"), UnknownSlot()},
		Key{"shared", 2}: []Slot{UnknownSlot(), UnknownSlot()},
	}
	context := mustContext(t,
		[]string{"field", "", "symbol"},
		[]Import{
			{Name: "shared", Version: 1},
			{Name: "shared", Version: 2},
		}, directory)
	if got, want := context.MaxSID(), uint64(8); got != want {
		t.Fatalf("target MaxSID = %d, want %d", got, want)
	}
	return context, directory
}

func TestRelocateMixedTokens(t *testing.T) {
	target, _ := newRelocationTarget(t)
	tokens := []Token{
		Known("field"),
		Known("annotation: 注释"),
		Known("symbol"),
		Known("x"),
		Known(""),
		LocalUnknown(),
		SharedUnknown("shared", 1),
		SharedUnknown("shared", 2),
		Known("new-symbol"),
		Known("annotation: 注释"),
		Known("new-symbol"),
		Known("field"),
	}

	result, sids, err := Relocate(tokens, target)
	if err != nil {
		t.Fatalf("Relocate: %v", err)
	}
	wantSIDs := []uint64{1, 9, 3, 5, 2, 0, 4, 8, 10, 9, 10, 1}
	if len(sids) != len(wantSIDs) {
		t.Fatalf("len(sids) = %d, want %d", len(sids), len(wantSIDs))
	}
	for index, want := range wantSIDs {
		if sids[index] != want {
			t.Fatalf("sids[%d] = %d, want %d (all sids: %v)",
				index, sids[index], want, sids)
		}
		resolved, err := result.Resolve(sids[index])
		if err != nil || !Equivalent(tokens[index], resolved) {
			t.Fatalf("result SID %d resolves to %s (err %v), want %s",
				sids[index], resolved, err, tokens[index])
		}
	}
	if result.LocalLen() != 2 || result.MaxSID() != 10 {
		t.Fatalf("result local=%d max=%d, want 2 and 10", result.LocalLen(), result.MaxSID())
	}
	if target.LocalLen() != 0 || target.MaxSID() != 8 {
		t.Fatalf("target was mutated: local=%d max=%d", target.LocalLen(), target.MaxSID())
	}
	if sid, found := result.Lookup(Known("annotation: 注释")); !found || sid != 9 {
		t.Fatalf("appended text lookup = (%d, %v), want (9, true)", sid, found)
	}
}

func TestRelocateAllOrNothingAndFirstFailureIndex(t *testing.T) {
	target, directory := newRelocationTarget(t)
	tokens := []Token{
		Known("would-have-been-appended"),
		SharedUnknown("absent", 1),
		Known("another-text"),
	}

	result, sids, err := Relocate(tokens, target)
	if err == nil {
		t.Fatal("Relocate succeeded, want failure")
	}
	if result != nil || sids != nil {
		t.Fatalf("failure delivered result=%v sids=%v, want nil/nil", result, sids)
	}
	var relocationError *RelocationError
	if !errors.As(err, &relocationError) {
		t.Fatalf("error type = %T, want *RelocationError", err)
	}
	if relocationError.Index != 1 {
		t.Fatalf("failure index = %d, want 1", relocationError.Index)
	}
	if !errors.Is(err, ErrNotRelocatable) {
		t.Fatalf("error does not wrap ErrNotRelocatable: %v", err)
	}

	if target.LocalLen() != 0 || target.MaxSID() != 8 {
		t.Fatalf("failed relocation mutated target")
	}
	if _, found := target.Lookup(Known("would-have-been-appended")); found {
		t.Fatal("failed relocation appended a local slot")
	}

	// A future directory update is not evidence that this target can encode
	// the shared unknown identity. The old target must still fail.
	directory[Key{"absent", 1}] = UnknownTable(1)
	if _, _, err := Relocate(tokens, target); err == nil {
		t.Fatal("old target accepted a future directory entry")
	}
	fresh := mustContext(t, nil, []Import{{Name: "absent", Version: 1}}, directory)
	if _, _, err := Relocate(tokens, fresh); err != nil {
		t.Fatalf("fresh target with downloaded unknown slot failed: %v", err)
	}
}

func TestRelocateWithIndexReportsSuccessAndFailure(t *testing.T) {
	target, _ := newRelocationTarget(t)
	result, sids, failIndex, err := RelocateWithIndex([]Token{Known("field"), LocalUnknown()}, target)
	if err != nil {
		t.Fatalf("RelocateWithIndex: %v", err)
	}
	if failIndex != -1 {
		t.Fatalf("success failIndex = %d, want -1", failIndex)
	}
	if result == nil || len(sids) != 2 || sids[0] != 1 || sids[1] != 0 {
		t.Fatalf("result=%v sids=%v", result, sids)
	}

	result, sids, failIndex, err = RelocateWithIndex(
		[]Token{Known("field"), SharedUnknown("shared", 4)}, target)
	if err == nil || result != nil || sids != nil || failIndex != 1 {
		t.Fatalf("failure result=%v sids=%v index=%d err=%v", result, sids, failIndex, err)
	}
}

func TestRelocateUsesUnknownIdentityNotNumericSID(t *testing.T) {
	sourceDirectory := Directory{
		Key{"shared", 1}: []Slot{UnknownSlot()},
	}
	source := mustContext(t,
		[]string{"s1", "s2", "s3"},
		[]Import{{Name: "shared", Version: 1}},
		sourceDirectory)
	sourceToken := mustResolve(t, source, 4)
	if !Equivalent(sourceToken, SharedUnknown("shared", 1)) {
		t.Fatalf("source token = %s", sourceToken)
	}

	targetDirectory := Directory{
		Key{"other", 1}:  []string{"o1", "o2", "o3"},
		Key{"shared", 1}: []Slot{KnownSlot("x"), UnknownSlot()},
		Key{"shared", 2}: []Slot{UnknownSlot(), UnknownSlot()},
	}
	target := mustContext(t,
		[]string{"a", "b", "c", "decoy"},
		[]Import{
			{Name: "other", Version: 1},
			{Name: "shared", Version: 1},
			{Name: "shared", Version: 2},
		}, targetDirectory)

	// Source SID 4 is SharedUnknown(shared, 1). Target SID 4 is the known text
	// "decoy"; target SID 8 is a known "x" at shared position 1. Only SID 10 is
	// the requested unknown identity.
	if got := mustResolve(t, target, 4); !Equivalent(got, Known("decoy")) {
		t.Fatalf("target SID 4 = %s", got)
	}
	_, sids, err := Relocate([]Token{sourceToken}, target)
	if err != nil {
		t.Fatalf("Relocate: %v", err)
	}
	if len(sids) != 1 || sids[0] != 10 {
		t.Fatalf("relocated SID = %v, want [10]", sids)
	}
	if got := mustResolve(t, target, sids[0]); !Equivalent(got, sourceToken) {
		t.Fatalf("relocated token = %s", got)
	}
}

func TestRelocateAppendsEmptyTextOnce(t *testing.T) {
	target := mustContext(t, []string{"field"}, nil, nil)
	result, sids, err := Relocate(
		[]Token{Known(""), Known(""), Known("field")}, target)
	if err != nil {
		t.Fatalf("Relocate: %v", err)
	}
	if got, want := sids, []uint64{2, 2, 1}; len(got) != len(want) || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Fatalf("sids = %v, want %v", got, want)
	}
	if result.LocalLen() != 1 || result.MaxSID() != 2 {
		t.Fatalf("result local=%d max=%d", result.LocalLen(), result.MaxSID())
	}
	if got := mustResolve(t, result, 2); !Equivalent(got, Known("")) {
		t.Fatalf("local slot = %s, want Known(empty)", got)
	}
}

func TestRelocationOverflowIsAtomic(t *testing.T) {
	target := mustContext(t, nil, []Import{
		ImportWithMax("huge", 1, math.MaxUint64),
	}, nil)
	_, sids, err := Relocate([]Token{Known("fresh")}, target)
	if err == nil || sids != nil {
		t.Fatalf("Relocate overflow err=%v sids=%v", err, sids)
	}
	var relocationError *RelocationError
	if !errors.As(err, &relocationError) || relocationError.Index != 0 {
		t.Fatalf("overflow error = %v", err)
	}
	if target.LocalLen() != 0 || target.MaxSID() != math.MaxUint64 {
		t.Fatal("overflow relocation mutated target")
	}

	almostFull := mustContext(t, nil, []Import{
		ImportWithMax("huge", 1, math.MaxUint64-1),
	}, nil)
	_, sids, failIndex, err := RelocateWithIndex([]Token{Known("a"), Known("b")}, almostFull)
	if err == nil || sids != nil || failIndex != 1 {
		t.Fatalf("partial overflow err=%v sids=%v index=%d", err, sids, failIndex)
	}
	if almostFull.LocalLen() != 0 || almostFull.MaxSID() != math.MaxUint64-1 {
		t.Fatal("partial overflow mutated target")
	}
}
