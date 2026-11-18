package formal

import (
	"math"
	"testing"
)

func TestMoneyParseAndString(t *testing.T) {
	t.Parallel()

	tests := []struct {
		input string
		want  Money
		text  string
	}{
		{"0", 0, "0.00"},
		{"1", 1_000_000, "1.00"},
		{"-1.5", -1_500_000, "-1.50"},
		{"0.000001", 1, "0.000001"},
		{"+12.340000", 12_340_000, "12.34"},
		{" 7.125 ", 7_125_000, "7.125"},
		{".5", 500_000, "0.50"},
		{"-0", 0, "0.00"},
	}
	for _, test := range tests {
		got, err := ParseMoney(test.input)
		if err != nil {
			t.Fatalf("ParseMoney(%q): %v", test.input, err)
		}
		if got != test.want {
			t.Fatalf("ParseMoney(%q) = %d, want %d", test.input, got, test.want)
		}
		if got.String() != test.text {
			t.Fatalf("Money(%d).String() = %q, want %q", got, got.String(), test.text)
		}
	}

	for _, invalid := range []string{"", " ", "abc", "1.2.3", "1.", "1.0000001", "1e3", "--1", "9223372036855"} {
		if _, err := ParseMoney(invalid); err == nil {
			t.Fatalf("ParseMoney(%q) unexpectedly succeeded", invalid)
		}
	}
}

func TestMoneyExtremesAndCents(t *testing.T) {
	t.Parallel()

	if got := MustParseMoney("9223372036854.775807"); got != Money(math.MaxInt64) {
		t.Fatalf("max money = %d", got)
	}
	if got := Money(math.MinInt64).String(); got != "-9223372036854.775808" {
		t.Fatalf("min money string = %q", got)
	}
	if got := MustFromCents(123); got != 1_230_000 {
		t.Fatalf("FromCents(123) = %d", got)
	}
	if _, err := FromCents(math.MaxInt64); err == nil {
		t.Fatal("expected cents overflow")
	}
	if _, err := ParseMoney("9223372036854.775808"); err == nil {
		t.Fatal("expected positive money overflow")
	}
}
