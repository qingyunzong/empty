package dataeng

import (
	"reflect"
	"strings"
	"testing"
)

func shiftMust(t *testing.T, formula string, rowDelta, colDelta int, want string, wantChanges []RefChange) {
	t.Helper()
	got, changes, err := ShiftFormula(formula, rowDelta, colDelta)
	if err != nil {
		t.Fatalf("ShiftFormula(%q) unexpected error: %v", formula, err)
	}
	if got != want {
		t.Fatalf("ShiftFormula(%q) = %q, want %q", formula, got, want)
	}
	if !reflect.DeepEqual(changes, wantChanges) {
		t.Fatalf("ShiftFormula(%q) changes = %#v, want %#v", formula, changes, wantChanges)
	}
	for _, change := range changes {
		if formula[change.ByteStart:change.ByteEnd] != change.Original {
			t.Fatalf("change interval %d:%d does not match original %q", change.ByteStart, change.ByteEnd, change.Original)
		}
	}
	verifyBytePreservation(t, formula, got, changes)
}

// verifyBytePreservation rebuilds the output from the original formula by
// replacing each recorded interval, proving every non-reference fragment is
// preserved byte-for-byte.
func verifyBytePreservation(t *testing.T, original, got string, changes []RefChange) {
	t.Helper()
	var rebuilt strings.Builder
	cursor := 0
	for _, change := range changes {
		rebuilt.WriteString(original[cursor:change.ByteStart])
		if change.RefError {
			rebuilt.WriteString(change.Replaced)
		} else {
			rebuilt.WriteString(change.Prefix)
			rebuilt.WriteString(change.Replaced)
		}
		cursor = change.ByteEnd
	}
	rebuilt.WriteString(original[cursor:])
	if rebuilt.String() != got {
		t.Fatalf("non-reference bytes changed:\n original=%q\n rebuilt =%q\n got     =%q", original, rebuilt.String(), got)
	}
}

func TestShiftMixedAbsoluteAndRelative(t *testing.T) {
	formula := "SUM($A$1,B2,$C3,D$4)+A1*$XFD$1048576"
	want := "SUM($A$1,C3,$C4,E$4)+B2*$XFD$1048576"
	wantChanges := []RefChange{
		{ByteStart: 4, ByteEnd: 8, Original: "$A$1", Replaced: "$A$1"},
		{ByteStart: 9, ByteEnd: 11, Original: "B2", Replaced: "C3"},
		{ByteStart: 12, ByteEnd: 15, Original: "$C3", Replaced: "$C4"},
		{ByteStart: 16, ByteEnd: 19, Original: "D$4", Replaced: "E$4"},
		{ByteStart: 21, ByteEnd: 23, Original: "A1", Replaced: "B2"},
		{ByteStart: 24, ByteEnd: 36, Original: "$XFD$1048576", Replaced: "$XFD$1048576"},
	}
	shiftMust(t, formula, 1, 1, want, wantChanges)
}

func TestShiftStringPseudoReferenceAndNumbers(t *testing.T) {
	formula := `IF(A1="B2 + LOG10(1E3)",12.5E-2+LOG10(42),A1)`
	want := `IF(B1="B2 + LOG10(1E3)",12.5E-2+LOG10(42),B1)`
	wantChanges := []RefChange{
		{ByteStart: 3, ByteEnd: 5, Original: "A1", Replaced: "B1"},
		{ByteStart: 42, ByteEnd: 44, Original: "A1", Replaced: "B1"},
	}
	shiftMust(t, formula, 0, 1, want, wantChanges)
}

func TestShiftQuotedSheetPrefix(t *testing.T) {
	formula := `='O''Brien''s Sheet'!A2+Sheet2!$B3:B10`
	want := `='O''Brien''s Sheet'!C3+Sheet2!$B4:D11`
	wantChanges := []RefChange{
		{
			ByteStart: 1, ByteEnd: 23,
			Prefix:   `'O''Brien''s Sheet'!`,
			Original: `'O''Brien''s Sheet'!A2`, Replaced: "C3",
		},
		{
			ByteStart: 24, ByteEnd: 38,
			Prefix:   "Sheet2!",
			Original: "Sheet2!$B3:B10", Replaced: "$B4:D11",
		},
	}
	shiftMust(t, formula, 1, 2, want, wantChanges)
}

func TestShiftNegativeDeltaBecomesRefError(t *testing.T) {
	formula := "A1+B2:C3+Data!D4"
	want := "#REF!+#REF!+#REF!"
	wantChanges := []RefChange{
		{ByteStart: 0, ByteEnd: 2, Original: "A1", Replaced: "#REF!", RefError: true},
		{ByteStart: 3, ByteEnd: 8, Original: "B2:C3", Replaced: "#REF!", RefError: true},
		{ByteStart: 9, ByteEnd: 16, Prefix: "Data!", Original: "Data!D4", Replaced: "#REF!", RefError: true},
	}
	shiftMust(t, formula, -5, -5, want, wantChanges)
}

func TestShiftBoundaryColumnsAndRows(t *testing.T) {
	formula := "XFD1+A1048576+XFE1+A1048577"
	_, _, err := ShiftFormula(formula, 0, 0)
	if err == nil {
		t.Fatalf("formula with out-of-sheet reference %q must be rejected", formula)
	}

	formula = "XFD1+A1048576"
	want := "#REF!+#REF!"
	wantChanges := []RefChange{
		{ByteStart: 0, ByteEnd: 4, Original: "XFD1", Replaced: "#REF!", RefError: true},
		{ByteStart: 5, ByteEnd: 13, Original: "A1048576", Replaced: "#REF!", RefError: true},
	}
	shiftMust(t, formula, 1, 1, want, wantChanges)
}

func TestShiftRangeKeepsAbsoluteEnds(t *testing.T) {
	formula := "A$1:$B$2"
	want := "C$1:$B$2"
	wantChanges := []RefChange{
		{ByteStart: 0, ByteEnd: 8, Original: "A$1:$B$2", Replaced: "C$1:$B$2"},
	}
	shiftMust(t, formula, 0, 2, want, wantChanges)
}

func TestShiftRejectsUnsupportedSyntax(t *testing.T) {
	cases := []struct {
		name    string
		formula string
	}{
		{"external workbook", "[Book1]Sheet1!A1"},
		{"3d reference", "Sheet1:Sheet2!XFD1"},
		{"structured table", "Table1[Column]"},
		{"named range", "Revenue*2"},
		{"lowercase reference", "a1+1"},
		{"leading zero row", "A01"},
		{"stray bang", "1+!B2"},
		{"unclosed quote", `'Sheet!A1`},
		{"unclosed string", `A1+"B2`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, err := ShiftFormula(tc.formula, 1, 1); err == nil {
				t.Fatalf("ShiftFormula(%q) expected error", tc.formula)
			}
		})
	}
}

func TestShiftExistingErrorLiteralAndOperatorsPreserved(t *testing.T) {
	formula := "A1/#REF!+#N/A&\"x\"<=100.5%"
	want := "B1/#REF!+#N/A&\"x\"<=100.5%"
	wantChanges := []RefChange{
		{ByteStart: 0, ByteEnd: 2, Original: "A1", Replaced: "B1"},
	}
	shiftMust(t, formula, 0, 1, want, wantChanges)
}

func TestShiftFunctionsBooleansAndDottedNames(t *testing.T) {
	formula := "LOG10 (A1)+_Hide.Me (B2)+TRUE+FALSE+LOG10(1E10)+100.25E-3"
	want := "LOG10 (B2)+_Hide.Me (C3)+TRUE+FALSE+LOG10(1E10)+100.25E-3"
	wantChanges := []RefChange{
		{ByteStart: 7, ByteEnd: 9, Original: "A1", Replaced: "B2"},
		{ByteStart: 21, ByteEnd: 23, Original: "B2", Replaced: "C3"},
	}
	shiftMust(t, formula, 1, 1, want, wantChanges)
}

func TestShiftUnquotedSheetPrefixPreserved(t *testing.T) {
	formula := "_S.x!A1+B1"
	want := "_S.x!B2+C2"
	wantChanges := []RefChange{
		{ByteStart: 0, ByteEnd: 7, Prefix: "_S.x!", Original: "_S.x!A1", Replaced: "B2"},
		{ByteStart: 8, ByteEnd: 10, Original: "B1", Replaced: "C2"},
	}
	shiftMust(t, formula, 1, 1, want, wantChanges)
}

func TestShiftRejectsBadSheetAndRangeGrammar(t *testing.T) {
	cases := []string{
		"''!A1",
		"'unterminated!A1",
		"A1:Sheet2!B2",
		"$A",
		"$A1:1",
		"XFE1",
	}
	for _, formula := range cases {
		if _, _, err := ShiftFormula(formula, 1, 1); err == nil {
			t.Fatalf("ShiftFormula(%q) expected error", formula)
		}
	}
}
