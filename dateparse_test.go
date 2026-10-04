package dateparse

import (
	"errors"
	"fmt"
	"testing"
)

func TestParseBasic(t *testing.T) {
	res, err := Parse("2024-02-29", []string{"YYYY-MM-DD"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := Date{Year: 2024, Month: 2, Day: 29}
	if res.Date != want {
		t.Fatalf("got %+v, want %+v", res.Date, want)
	}
	if res.Start != 0 || res.End != len("2024-02-29") {
		t.Fatalf("interval = [%d,%d), want [0,10)", res.Start, res.End)
	}
	if len(res.MatchedFormats) != 1 || res.MatchedFormats[0] != "YYYY-MM-DD" {
		t.Fatalf("matched formats = %v", res.MatchedFormats)
	}
}

func TestParseFindsIntervalInLargerString(t *testing.T) {
	input := "born on 2000-12-31!"
	res, err := Parse(input, []string{"YYYY-MM-DD"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Start != 8 || res.End != 18 {
		t.Fatalf("interval = [%d,%d), want [8,18)", res.Start, res.End)
	}
	if input[res.Start:res.End] != "2000-12-31" {
		t.Fatalf("interval slice = %q", input[res.Start:res.End])
	}
}

func TestAmbiguityReportedNotGuessed(t *testing.T) {
	// 03/04/2005 is 3 April under DD/MM/YYYY but 4 March under MM/DD/YYYY.
	_, err := Parse("03/04/2005", []string{"DD/MM/YYYY", "MM/DD/YYYY"})
	var amb *AmbiguityError
	if !errors.As(err, &amb) {
		t.Fatalf("expected AmbiguityError, got %v", err)
	}
	if len(amb.Candidates) != 2 {
		t.Fatalf("candidates = %v", amb.Candidates)
	}
	a, b := amb.Candidates[0], amb.Candidates[1]
	if a.Date.Day != 3 || a.Date.Month != 4 || b.Date.Day != 4 || b.Date.Month != 3 {
		t.Fatalf("candidates = %+v, %+v", a, b)
	}
	if amb.Start != 0 || amb.End != 10 {
		t.Fatalf("ambiguity interval = [%d,%d)", amb.Start, amb.End)
	}
}

func TestMultipleFormatsAgreeingIsNotAmbiguous(t *testing.T) {
	// Both formats parse to the same date here, so no ambiguity.
	res, err := Parse("05/05/2005", []string{"DD/MM/YYYY", "MM/DD/YYYY"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Date.Month != 5 || res.Date.Day != 5 {
		t.Fatalf("got %+v", res.Date)
	}
	if len(res.MatchedFormats) != 2 {
		t.Fatalf("matched formats = %v", res.MatchedFormats)
	}
}

func TestLeapSecondRejected(t *testing.T) {
	_, err := Parse("2016-12-31T23:59:60", []string{"YYYY-MM-DDTHH:mm:ss"})
	if !errors.Is(err, ErrLeapSecond) {
		t.Fatalf("expected ErrLeapSecond, got %v", err)
	}
}

func TestSecond61IsPlainInvalid(t *testing.T) {
	_, err := Parse("2016-12-31T23:59:61", []string{"YYYY-MM-DDTHH:mm:ss"})
	if !errors.Is(err, ErrNoMatch) {
		t.Fatalf("expected ErrNoMatch, got %v", err)
	}
}

func TestOffsetAsIntegerMinutes(t *testing.T) {
	cases := []struct {
		input string
		want  int
	}{
		{"2024-01-01T00:00:00+05:30", 330},
		{"2024-01-01T00:00:00-08:00", -480},
		{"2024-01-01T00:00:00+00:00", 0},
		{"2024-01-01T00:00:00+14:00", 840},
	}
	for _, c := range cases {
		res, err := Parse(c.input, []string{"YYYY-MM-DDTHH:mm:ssZ"})
		if err != nil {
			t.Fatalf("%s: unexpected error: %v", c.input, err)
		}
		if !res.Date.HasOffset || res.Date.OffsetMinutes != c.want {
			t.Fatalf("%s: offset = %d, want %d", c.input, res.Date.OffsetMinutes, c.want)
		}
	}
}

func TestInvalidDatesRejected(t *testing.T) {
	formats := []string{"YYYY-MM-DD"}
	for _, input := range []string{
		"2023-02-29", // not a leap year
		"1900-02-29", // century, not divisible by 400
		"2024-04-31", // April has 30 days
		"2024-13-01", // month out of range
		"2024-00-10", // month zero
		"2024-01-00", // day zero
		"2024-01-32", // day out of range
	} {
		if _, err := Parse(input, formats); !errors.Is(err, ErrNoMatch) {
			t.Fatalf("%s: expected ErrNoMatch, got %v", input, err)
		}
	}
}

func TestBoundaryYearsExplicit(t *testing.T) {
	cases := []struct {
		year int
		leap bool
	}{
		{4, true}, {100, false}, {400, true},
		{1600, true}, {1700, false}, {1800, false}, {1900, false},
		{1996, true}, {1999, false}, {2000, true}, {2004, true},
		{2100, false}, {2400, true}, {9996, true}, {9999, false},
	}
	for _, c := range cases {
		if got := IsLeapYear(c.year); got != c.leap {
			t.Errorf("IsLeapYear(%d) = %v, want %v", c.year, got, c.leap)
		}
		input := fmt.Sprintf("%04d-02-29", c.year)
		_, err := Parse(input, []string{"YYYY-MM-DD"})
		if c.leap && err != nil {
			t.Errorf("%s should parse (leap year), got %v", input, err)
		}
		if !c.leap && !errors.Is(err, ErrNoMatch) {
			t.Errorf("%s should be rejected, got %v", input, err)
		}
	}
}

// TestExhaustiveYears checks every representable year 0000-9999: the leap
// year rule, February's length, and end-to-end parsing of Feb 28/29 must
// all agree with the explicit Gregorian rule.
func TestExhaustiveYears(t *testing.T) {
	formats := []string{"YYYY-MM-DD"}
	for year := 0; year <= 9999; year++ {
		wantLeap := year%4 == 0 && (year%100 != 0 || year%400 == 0)
		if got := IsLeapYear(year); got != wantLeap {
			t.Fatalf("IsLeapYear(%d) = %v, want %v", year, got, wantLeap)
		}
		wantFeb := 28
		if wantLeap {
			wantFeb = 29
		}
		if got := DaysInMonth(year, 2); got != wantFeb {
			t.Fatalf("DaysInMonth(%d, 2) = %d, want %d", year, got, wantFeb)
		}

		feb29 := fmt.Sprintf("%04d-02-29", year)
		_, err := Parse(feb29, formats)
		if wantLeap && err != nil {
			t.Fatalf("%s rejected in leap year: %v", feb29, err)
		}
		if !wantLeap && !errors.Is(err, ErrNoMatch) {
			t.Fatalf("%s accepted in non-leap year", feb29)
		}

		feb28 := fmt.Sprintf("%04d-02-28", year)
		res, err := Parse(feb28, formats)
		if err != nil {
			t.Fatalf("%s rejected: %v", feb28, err)
		}
		if res.Date.Year != year || res.Date.Month != 2 || res.Date.Day != 28 {
			t.Fatalf("%s parsed as %+v", feb28, res.Date)
		}
	}
}

// TestExhaustiveMonthLengths checks every month of a leap and a non-leap
// year: the last valid day parses and the day after it does not.
func TestExhaustiveMonthLengths(t *testing.T) {
	formats := []string{"YYYY-MM-DD"}
	for _, year := range []int{1999, 2000} {
		for month := 1; month <= 12; month++ {
			last := DaysInMonth(year, month)
			ok := fmt.Sprintf("%04d-%02d-%02d", year, month, last)
			if _, err := Parse(ok, formats); err != nil {
				t.Fatalf("%s rejected: %v", ok, err)
			}
			bad := fmt.Sprintf("%04d-%02d-%02d", year, month, last+1)
			if _, err := Parse(bad, formats); !errors.Is(err, ErrNoMatch) {
				t.Fatalf("%s accepted, want ErrNoMatch (got %v)", bad, err)
			}
		}
	}
}

func TestNoMatchAndNoFormats(t *testing.T) {
	if _, err := Parse("not a date", []string{"YYYY-MM-DD"}); !errors.Is(err, ErrNoMatch) {
		t.Fatalf("expected ErrNoMatch, got %v", err)
	}
	if _, err := Parse("2024-01-01", nil); err == nil {
		t.Fatal("expected error for empty format set")
	}
}
