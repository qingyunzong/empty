package dataeng

import (
	"errors"
	"math/big"
	"math/rand"
	"strings"
	"testing"
)

func mustBigInt(t *testing.T, s string) *big.Int {
	t.Helper()
	n, ok := new(big.Int).SetString(s, 10)
	if !ok {
		t.Fatalf("bad big.Int literal %q", s)
	}
	return n
}

func TestParseCellValid(t *testing.T) {
	cases := []struct {
		cell      string
		digits    string
		intDigits int
		scale     int
	}{
		{"0", "0", 1, 0},
		{"000", "0", 1, 0},
		{"00123", "123", 3, 0},
		{"-0", "0", 1, 0},
		{"-00.00", "0", 1, 2},
		{"12.30", "1230", 2, 2},
		{"-12.30", "-1230", 2, 2},
		{"0.0001", "1", 1, 4},
		{"-999.999", "-999999", 3, 3},
	}
	for _, tc := range cases {
		p, err := ParseCell(tc.cell)
		if err != nil {
			t.Fatalf("ParseCell(%q) unexpected error: %v", tc.cell, err)
		}
		if p.null {
			t.Fatalf("ParseCell(%q) unexpectedly null", tc.cell)
		}
		if p.digits.Cmp(mustBigInt(t, tc.digits)) != 0 {
			t.Errorf("ParseCell(%q) digits = %s, want %s", tc.cell, p.digits, tc.digits)
		}
		if p.intDigits != tc.intDigits || p.scale != tc.scale {
			t.Errorf("ParseCell(%q) intDigits/scale = %d/%d, want %d/%d",
				tc.cell, p.intDigits, p.scale, tc.intDigits, tc.scale)
		}
	}
}

func TestParseCellNullAndInvalid(t *testing.T) {
	if p, err := ParseCell(NullCell); err != nil || !p.null {
		t.Fatalf("null cell parse = %+v, %v", p, err)
	}
	invalid := []string{
		"1e3", "1E3", " 1.2", "1.2 ", "1.", ".5", "+", "-",
		"0x1", "1_000", "--1", "1.2.3", "abc", "1,2", "  ",
	}
	for _, cell := range invalid {
		if _, err := ParseCell(cell); !errors.Is(err, ErrInvalidCell) {
			t.Errorf("ParseCell(%q) error = %v, want ErrInvalidCell", cell, err)
		}
	}
}

func TestBatchPromotionAndImmutableView(t *testing.T) {
	col := NewColumn(10)

	view1, err := col.AppendBatch([]string{"12.3", "0.5", NullCell, "-7"})
	if err != nil {
		t.Fatal(err)
	}
	if got := view1.Schema(); got != (Schema{Precision: 3, Scale: 1, Defined: true}) {
		t.Fatalf("view1 schema = %+v", got)
	}
	wantRows1 := []Row{
		{Value: mustBigInt(t, "123"), OriginalScale: 1},
		{Value: mustBigInt(t, "5"), OriginalScale: 1},
		{Value: nil, OriginalScale: 0},
		{Value: mustBigInt(t, "-70"), OriginalScale: 0},
	}
	if !rowsEqual(view1, wantRows1) {
		t.Fatalf("view1 rows mismatch: %+v", dumpView(view1))
	}

	view2, err := col.AppendBatch([]string{"1.250", "-0.025"})
	if err != nil {
		t.Fatal(err)
	}
	if got := view2.Schema(); got != (Schema{Precision: 5, Scale: 3, Defined: true}) {
		t.Fatalf("view2 schema = %+v", got)
	}

	// Old view keeps its original scale and original values.
	if got := view1.Schema(); got != (Schema{Precision: 3, Scale: 1, Defined: true}) {
		t.Fatalf("view1 schema changed: %+v", got)
	}
	if !rowsEqual(view1, wantRows1) {
		t.Fatalf("view1 rows changed: %+v", dumpView(view1))
	}

	// New view reinterprets previously delivered rows at scale 3.
	wantRows2 := []Row{
		{Value: mustBigInt(t, "12300"), OriginalScale: 1},
		{Value: mustBigInt(t, "500"), OriginalScale: 1},
		{Value: nil, OriginalScale: 0},
		{Value: mustBigInt(t, "-7000"), OriginalScale: 0},
		{Value: mustBigInt(t, "1250"), OriginalScale: 3},
		{Value: mustBigInt(t, "-25"), OriginalScale: 3},
	}
	if !rowsEqual(view2, wantRows2) {
		t.Fatalf("view2 rows mismatch: %+v", dumpView(view2))
	}

	// Repeated View() calls return the same snapshot until the next commit.
	if col.View() != view2 {
		t.Fatal("View() did not reuse the current immutable view")
	}

	wantRestore := []string{"12.3", "0.5", NullCell, "-7", "1.250", "-0.025"}
	for i, want := range wantRestore {
		if got := view2.Restore(i); got != want {
			t.Errorf("Restore(%d) = %q, want %q", i, got, want)
		}
	}
}

func TestNegativeZero(t *testing.T) {
	col := NewColumn(10)
	view, err := col.AppendBatch([]string{"-0", "-0.00", "-0.50", "0.0"})
	if err != nil {
		t.Fatal(err)
	}
	if view.Row(0).Value.Sign() != 0 || view.Row(1).Value.Sign() != 0 {
		t.Fatal("negative zero must be stored as numeric zero")
	}
	want := []string{"0", "0.00", "-0.50", "0.0"}
	for i, w := range want {
		if got := view.Restore(i); got != w {
			t.Errorf("Restore(%d) = %q, want %q", i, got, w)
		}
	}
	row := view.Row(2)
	if row.OriginalScale != 2 || row.Value.Cmp(mustBigInt(t, "-50")) != 0 {
		t.Fatalf("negative scaled row = %+v", row)
	}
}

func TestPrecisionLimitBoundaryAndRecovery(t *testing.T) {
	col := NewColumn(5)

	if _, err := col.AppendBatch([]string{"12.34"}); err != nil {
		t.Fatal(err) // precision 2 + 2 = 4
	}
	if _, err := col.AppendBatch([]string{"1.234"}); err != nil {
		t.Fatal(err) // scale 3, precision 2 + 3 = 5, exactly at limit
	}

	before := col.View()
	_, err := col.AppendBatch([]string{"123.45"})
	var limitErr *LimitError
	if !errors.As(err, &limitErr) {
		t.Fatalf("expected LimitError, got %v", err)
	}
	if limitErr.Limit != 5 || limitErr.ProposedPrecision != 6 {
		t.Fatalf("LimitError fields = %+v", limitErr)
	}
	if !errors.Is(err, ErrLimitExceeded) {
		t.Fatal("LimitError must wrap ErrLimitExceeded")
	}

	// Rejected batch leaves prior state untouched.
	after := col.View()
	if after != before || after.Len() != 2 {
		t.Fatalf("state changed after rejected batch: len=%d", after.Len())
	}

	// A conforming batch is accepted afterwards.
	view, err := col.AppendBatch([]string{"9.0"})
	if err != nil {
		t.Fatalf("accept after reject failed: %v", err)
	}
	if view.Len() != 3 || view.Schema() != (Schema{Precision: 5, Scale: 3, Defined: true}) {
		t.Fatalf("post-recovery view = %+v len=%d", view.Schema(), view.Len())
	}
	if got := view.Restore(2); got != "9.0" {
		t.Errorf("Restore = %q, want 9.0", got)
	}
}

func TestInvalidCellRejectsWholeBatch(t *testing.T) {
	col := NewColumn(20)
	if _, err := col.AppendBatch([]string{"1.1", "2.2"}); err != nil {
		t.Fatal(err)
	}

	_, err := col.AppendBatch([]string{"3.3", "4e4", "5.5"})
	var cellErr *CellError
	if !errors.As(err, &cellErr) {
		t.Fatalf("expected CellError, got %v", err)
	}
	if cellErr.Row != 1 || cellErr.Cell != "4e4" {
		t.Fatalf("CellError fields = %+v", cellErr)
	}
	if !errors.Is(err, ErrInvalidCell) {
		t.Fatal("CellError must wrap ErrInvalidCell")
	}
	if col.View().Len() != 2 {
		t.Fatal("part of a rejected batch was committed")
	}
}

func TestAllNullColumnUndefined(t *testing.T) {
	col := NewColumn(8)
	view, err := col.AppendBatch([]string{NullCell, NullCell})
	if err != nil {
		t.Fatal(err)
	}
	if view.Schema().Defined || view.Schema().Precision != 0 || view.Schema().Scale != 0 {
		t.Fatalf("all-null schema should be undefined, got %+v", view.Schema())
	}
	if view.Len() != 2 || view.Row(0).Value != nil || view.Restore(0) != NullCell {
		t.Fatal("all-null rows must stay null")
	}

	if _, err := col.AppendBatch([]string{NullCell}); err != nil {
		t.Fatal(err)
	}
	if col.View().Schema().Defined {
		t.Fatal("schema still undefined after another null batch")
	}

	view, err = col.AppendBatch([]string{"0.1"})
	if err != nil {
		t.Fatal(err)
	}
	if got := view.Schema(); got != (Schema{Precision: 2, Scale: 1, Defined: true}) {
		t.Fatalf("schema after first value = %+v", got)
	}
	if view.Len() != 4 || view.Row(0).Value != nil || view.Row(3).Value.Cmp(big.NewInt(1)) != 0 {
		t.Fatal("history was not retained when schema became defined")
	}

	// An empty batch on a fresh column yields an empty, undefined view.
	fresh := NewColumn(3)
	empty, err := fresh.AppendBatch(nil)
	if err != nil || empty.Len() != 0 || empty.Schema().Defined {
		t.Fatalf("empty batch view = %+v, err=%v", empty.Schema(), err)
	}
}

func TestLosslessRoundTrip(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	col := NewColumn(300)
	var inputs []string

	for batch := 0; batch < 12; batch++ {
		n := 2 + rng.Intn(5)
		cells := make([]string, n)
		for i := range cells {
			if rng.Intn(5) == 0 {
				cells[i] = NullCell
				continue
			}
			cells[i] = randomDecimal(rng)
		}
		view, err := col.AppendBatch(cells)
		if err != nil {
			t.Fatalf("batch %d rejected: %v", batch, err)
		}
		inputs = append(inputs, cells...)

		for i, in := range inputs {
			row := view.Row(i)
			if in == NullCell {
				if row.Value != nil || view.Restore(i) != NullCell {
					t.Fatalf("null row %d altered", i)
				}
				continue
			}
			canonical := canonicalDecimal(in)
			if got := view.Restore(i); got != canonical {
				t.Fatalf("Restore(%d) = %q, want %q (input %q)", i, got, canonical, in)
			}
			if row.OriginalScale != fracLen(in) {
				t.Fatalf("row %d original scale = %d, want %d", i, row.OriginalScale, fracLen(in))
			}
			wantRat := decimalRat(t, in)
			gotRat := new(big.Rat).SetFrac(row.Value, powersOfTen(view.Schema().Scale))
			if gotRat.Cmp(wantRat) != 0 {
				t.Fatalf("row %d numeric value %s != %s", i, gotRat, wantRat)
			}
		}
	}
}

func TestArbitraryPrecision(t *testing.T) {
	huge := strings.Repeat("7", 60) + "." + strings.Repeat("3", 30)
	col := NewColumn(100)
	view, err := col.AppendBatch([]string{huge})
	if err != nil {
		t.Fatal(err)
	}
	if got := view.Schema(); got != (Schema{Precision: 90, Scale: 30, Defined: true}) {
		t.Fatalf("schema = %+v", got)
	}
	if view.Restore(0) != huge {
		t.Fatal("large decimal was not preserved")
	}

	over := strings.Repeat("1", 80)
	if _, err := NewColumn(50).AppendBatch([]string{over}); err == nil {
		t.Fatal("precision over limit must be rejected")
	}
}

func TestViewRowCopy(t *testing.T) {
	col := NewColumn(10)
	view, err := col.AppendBatch([]string{"12.34"})
	if err != nil {
		t.Fatal(err)
	}
	view.Row(0).Value.SetInt64(999999)
	if view.Row(0).Value.Cmp(mustBigInt(t, "1234")) != 0 {
		t.Fatal("mutating a returned row changed view state")
	}
}

func TestFormatDecimal(t *testing.T) {
	cases := []struct {
		value string
		scale int
		want  string
	}{
		{"0", 0, "0"},
		{"0", 2, "0.00"},
		{"5", 3, "0.005"},
		{"1234", 2, "12.34"},
		{"-1234", 2, "-12.34"},
		{"-5", 3, "-0.005"},
		{"1", 6, "0.000001"},
	}
	for _, tc := range cases {
		if got := FormatDecimal(mustBigInt(t, tc.value), tc.scale); got != tc.want {
			t.Errorf("FormatDecimal(%s, %d) = %q, want %q", tc.value, tc.scale, got, tc.want)
		}
	}
}

func rowsEqual(v *View, want []Row) bool {
	if v.Len() != len(want) {
		return false
	}
	for i := range want {
		got := v.Row(i)
		if got.OriginalScale != want[i].OriginalScale {
			return false
		}
		switch {
		case got.Value == nil && want[i].Value == nil:
		case got.Value == nil || want[i].Value == nil:
			return false
		case got.Value.Cmp(want[i].Value) != 0:
			return false
		}
	}
	return true
}

func dumpView(v *View) []Row {
	rows := make([]Row, v.Len())
	for i := range rows {
		rows[i] = v.Row(i)
	}
	return rows
}

func randomDecimal(rng *rand.Rand) string {
	intLen := 1 + rng.Intn(40)
	fracLen := rng.Intn(40)
	intDigits := make([]byte, intLen)
	for i := range intDigits {
		intDigits[i] = byte('0' + rng.Intn(10))
	}
	intDigits[0] = byte('1' + rng.Intn(9))
	s := string(intDigits)
	if fracLen > 0 {
		fracDigits := make([]byte, fracLen)
		for i := range fracDigits {
			fracDigits[i] = byte('0' + rng.Intn(10))
		}
		s += "." + string(fracDigits)
	}
	if rng.Intn(2) == 0 {
		s = "-" + s
	}
	return s
}

func fracLen(cell string) int {
	if i := strings.IndexByte(cell, '.'); i >= 0 {
		return len(cell) - i - 1
	}
	return 0
}

func canonicalDecimal(cell string) string {
	negative := false
	if cell[0] == '-' {
		negative = true
		cell = cell[1:]
	}
	intPart := cell
	fracPart := ""
	if i := strings.IndexByte(cell, '.'); i >= 0 {
		intPart = cell[:i]
		fracPart = cell[i+1:]
	}
	intPart = trimLeadingZeros(intPart)
	sign := ""
	if negative && (intPart != "0" || (fracPart != "" && !allZeros(fracPart))) {
		sign = "-"
	}
	if fracPart == "" {
		return sign + intPart
	}
	return sign + intPart + "." + fracPart
}

func allZeros(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] != '0' {
			return false
		}
	}
	return true
}

func decimalRat(t *testing.T, cell string) *big.Rat {
	t.Helper()
	scale := fracLen(cell)
	p, err := ParseCell(cell)
	if err != nil {
		t.Fatalf("decimalRat parse %q: %v", cell, err)
	}
	return new(big.Rat).SetFrac(p.digits, powersOfTen(scale))
}
