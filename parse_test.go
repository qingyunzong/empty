package dateparse

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

func mustParse(t *testing.T, input string, formats ...string) Result {
	t.Helper()
	r, err := Parse(input, formats)
	if err != nil {
		t.Fatalf("Parse(%q, %v) returned error: %v", input, formats, err)
	}
	return r
}

func TestParseBasic(t *testing.T) {
	r := mustParse(t, "2025-03-04", "2006-01-02")
	d := r.Date
	if d.Year != 2025 || d.Month != 3 || d.Day != 4 {
		t.Fatalf("got %v", d)
	}
	if d.HasTime || d.HasOffset {
		t.Fatalf("unexpected time/offset: %+v", d)
	}
	if r.Format != "2006-01-02" || r.Start != 0 || r.End != 10 {
		t.Fatalf("format=%q span=[%d:%d)", r.Format, r.Start, r.End)
	}
}

func TestParseSpanInText(t *testing.T) {
	input := "Event: 2025-03-04 (confirmed)"
	r := mustParse(t, input, "2006-01-02")
	if r.Start != 7 || r.End != 17 {
		t.Fatalf("span=[%d:%d), want [7:17)", r.Start, r.End)
	}
	if got := r.Text(input); got != "2025-03-04" {
		t.Fatalf("Text = %q", got)
	}
}

func TestParseDoesNotSplitDigitRuns(t *testing.T) {
	// "13/1/2025" must not be read as month=3 day=1 hiding inside a digit run.
	input := "13/1/2025"
	if _, err := Parse(input, []string{"1/2/2006"}); err == nil {
		t.Fatalf("expected no match for %q", input)
	} else if _, ok := err.(*NoMatchError); !ok {
		t.Fatalf("expected NoMatchError, got %T: %v", err, err)
	}
}

func TestParseMultipleFormatsAgree(t *testing.T) {
	r := mustParse(t, "2025-03-04", "2006-01-02", "2006-1-2")
	if len(r.Formats) != 2 {
		t.Fatalf("Formats = %v, want both formats", r.Formats)
	}
	if r.Format != "2006-01-02" {
		t.Fatalf("primary Format = %q", r.Format)
	}
}

func TestParseAmbiguity(t *testing.T) {
	// 03/04 is March 4 under M/D/Y but April 3 under D/M/Y: the library
	// must report the ambiguity instead of guessing.
	_, err := Parse("03/04/2025", []string{"01/02/2006", "02/01/2006"})
	var amb *AmbiguityError
	if !errors.As(err, &amb) {
		t.Fatalf("expected AmbiguityError, got %v", err)
	}
	if len(amb.Candidates) != 2 {
		t.Fatalf("candidates = %v", amb.Candidates)
	}
	a, b := amb.Candidates[0].Date, amb.Candidates[1].Date
	if (a.Month == b.Month) || a.Day != b.Month || a.Month != b.Day {
		t.Fatalf("candidates should swap month/day: %v vs %v", a, b)
	}
}

func TestParseAmbiguitySameDateOK(t *testing.T) {
	// 05/05 resolves to the same date under both orders: no ambiguity.
	r := mustParse(t, "05/05/2025", "01/02/2006", "02/01/2006")
	if r.Date.Month != 5 || r.Date.Day != 5 {
		t.Fatalf("got %v", r.Date)
	}
	if len(r.Formats) != 2 {
		t.Fatalf("Formats = %v", r.Formats)
	}
}

func TestParseNoMatch(t *testing.T) {
	_, err := Parse("not a date at all", []string{"2006-01-02"})
	var nm *NoMatchError
	if !errors.As(err, &nm) {
		t.Fatalf("expected NoMatchError, got %v", err)
	}
}

func TestParseEmptyFormats(t *testing.T) {
	if _, err := Parse("2025-03-04", nil); err == nil {
		t.Fatal("expected error for empty format list")
	}
}

func TestFormatMustNotGuessFields(t *testing.T) {
	// Formats missing year, month or day are rejected outright: the library
	// never invents the missing fields.
	for _, f := range []string{"2006-01", "01-02", "2006", "15:04:05", "January 2006"} {
		if _, err := Parse("2025-03-04", []string{f}); err == nil {
			t.Fatalf("format %q: expected FormatError", f)
		} else {
			var fe *FormatError
			if !errors.As(err, &fe) {
				t.Fatalf("format %q: expected FormatError, got %T: %v", f, err, err)
			}
		}
	}
}

func TestLeapSecondRejected(t *testing.T) {
	cases := []struct {
		input  string
		format string
	}{
		{"2016-12-31 23:59:60", "2006-01-02 15:04:05"},
		{"2016-12-31T23:59:60Z", "2006-01-02T15:04:05Z07:00"},
		{"2016-12-31T23:59:60+08:00", "2006-01-02T15:04:05-07:00"},
		{"at 23:59:60 on 2016-12-31", "at 15:04:05 on 2006-01-02"},
	}
	for _, c := range cases {
		_, err := Parse(c.input, []string{c.format})
		var ls *LeapSecondError
		if !errors.As(err, &ls) {
			t.Errorf("input %q: expected LeapSecondError, got %v", c.input, err)
		}
	}
}

func TestSecondOutOfRange(t *testing.T) {
	// 61 is not a leap second, just invalid: no match.
	if _, err := Parse("2016-12-31 23:59:61", []string{"2006-01-02 15:04:05"}); err == nil {
		t.Fatal("expected error for seconds=61")
	} else {
		var nm *NoMatchError
		if !errors.As(err, &nm) {
			t.Fatalf("expected NoMatchError, got %T: %v", err, err)
		}
	}
}

func TestZoneOffsets(t *testing.T) {
	cases := []struct {
		input   string
		format  string
		minutes int
	}{
		{"2025-03-04+08:00", "2006-01-02-07:00", 480},
		{"2025-03-04-05:30", "2006-01-02-07:00", -330},
		{"2025-03-04+0530", "2006-01-02-0700", 330},
		{"2025-03-04-07", "2006-01-02-07", -420},
		{"2025-03-04Z", "2006-01-02Z07:00", 0},
		{"2025-03-04+14:00", "2006-01-02Z07:00", 840},
		{"2025-03-04-12:00", "2006-01-02Z07:00", -720},
	}
	for _, c := range cases {
		r := mustParse(t, c.input, c.format)
		if !r.Date.HasOffset {
			t.Fatalf("%q: no offset parsed", c.input)
		}
		if r.Date.OffsetMinutes != c.minutes {
			t.Errorf("%q: offset = %d min, want %d", c.input, r.Date.OffsetMinutes, c.minutes)
		}
	}
}

func TestZoneOffsetInvalid(t *testing.T) {
	for _, in := range []string{"2025-03-04+24:00", "2025-03-04+08:60", "2025-03-04+0a:00"} {
		if _, err := Parse(in, []string{"2006-01-02-07:00"}); err == nil {
			t.Errorf("%q: expected no match", in)
		}
	}
}

func TestTwoDigitYear(t *testing.T) {
	cases := map[string]int{"00": 2000, "68": 2068, "69": 1969, "99": 1999}
	for yy, want := range cases {
		r := mustParse(t, yy+"-03-04", "06-01-02")
		if r.Date.Year != want {
			t.Errorf("year %q -> %d, want %d", yy, r.Date.Year, want)
		}
	}
}

func TestMonthNames(t *testing.T) {
	r := mustParse(t, "4 Jan 2025", "2 Jan 2006")
	if r.Date.Month != 1 || r.Date.Day != 4 {
		t.Fatalf("got %v", r.Date)
	}
	r = mustParse(t, "September 30, 2024", "January 2, 2006")
	if r.Date.Month != 9 || r.Date.Day != 30 {
		t.Fatalf("got %v", r.Date)
	}
	// Case-insensitive.
	r = mustParse(t, "4 jAN 2025", "2 Jan 2006")
	if r.Date.Month != 1 {
		t.Fatalf("got %v", r.Date)
	}
}

func TestTwelveHourClock(t *testing.T) {
	cases := []struct {
		input string
		hour  int
	}{
		{"2025-03-04 03:04:05 PM", 15},
		{"2025-03-04 12:00:00 PM", 12},
		{"2025-03-04 12:00:00 AM", 0},
		{"2025-03-04 11:59:59 pm", 23},
	}
	for _, c := range cases {
		r := mustParse(t, c.input, "2006-01-02 03:04:05 PM", "2006-01-02 03:04:05 pm")
		if r.Date.Hour != c.hour {
			t.Errorf("%q: hour = %d, want %d", c.input, r.Date.Hour, c.hour)
		}
		if !r.Date.HasTime {
			t.Errorf("%q: HasTime = false", c.input)
		}
	}
}

func TestInvalidDates(t *testing.T) {
	for _, in := range []string{
		"2025-02-30", "2025-04-31", "2025-13-01", "2025-00-10",
		"2025-01-00", "2025-01-32", "2023-02-29",
	} {
		if _, err := Parse(in, []string{"2006-01-02"}); err == nil {
			t.Errorf("%q: expected no match", in)
		}
	}
}

func TestUnpaddedFields(t *testing.T) {
	r := mustParse(t, "2025-3-4", "2006-1-2")
	if r.Date.Month != 3 || r.Date.Day != 4 {
		t.Fatalf("got %v", r.Date)
	}
	r = mustParse(t, "2025-11-21", "2006-1-2")
	if r.Date.Month != 11 || r.Date.Day != 21 {
		t.Fatalf("got %v", r.Date)
	}
}

func TestTimeRoundTrip(t *testing.T) {
	r := mustParse(t, "2025-03-04T10:20:30+08:00", "2006-01-02T15:04:05-07:00")
	got := r.Date.Time().UTC()
	want := time.Date(2025, 3, 4, 2, 20, 30, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("UTC instant = %v, want %v", got, want)
	}
}

// TestExhaustiveBoundaryYears checks every year in the four-digit range
// against the explicit Gregorian rules and cross-checks the month lengths
// with the standard library.
func TestExhaustiveBoundaryYears(t *testing.T) {
	formats := []string{"2006-01-02"}
	for y := 0; y <= 9999; y++ {
		leap := isLeap(y)

		// Cross-check the leap rule with the standard library: Feb 29
		// must survive time.Date normalization exactly on leap years.
		std := time.Date(y, time.February, 29, 0, 0, 0, 0, time.UTC)
		if (std.Month() == time.February) != leap {
			t.Fatalf("year %d: isLeap=%v disagrees with stdlib", y, leap)
		}

		// Feb 29 parses exactly on leap years.
		feb29 := fmt.Sprintf("%04d-02-29", y)
		_, err := Parse(feb29, formats)
		if leap && err != nil {
			t.Fatalf("year %d: %s should parse: %v", y, feb29, err)
		}
		if !leap && err == nil {
			t.Fatalf("year %d: %s should not parse", y, feb29)
		}

		// Feb 30 never parses.
		if _, err := Parse(fmt.Sprintf("%04d-02-30", y), formats); err == nil {
			t.Fatalf("year %d: Feb 30 should never parse", y)
		}

		for m := 1; m <= 12; m++ {
			// Cross-check the month length with the standard library.
			want := time.Date(y, time.Month(m)+1, 0, 0, 0, 0, 0, time.UTC).Day()
			if got := daysIn(y, m); got != want {
				t.Fatalf("year %d month %d: daysIn=%d, stdlib=%d", y, m, got, want)
			}
			// The last day of the month parses...
			last := fmt.Sprintf("%04d-%02d-%02d", y, m, want)
			r, err := Parse(last, formats)
			if err != nil {
				t.Fatalf("%s: %v", last, err)
			}
			if r.Date.Year != y || r.Date.Month != m || r.Date.Day != want {
				t.Fatalf("%s: got %v", last, r.Date)
			}
			// ...and the day after it does not.
			over := fmt.Sprintf("%04d-%02d-%02d", y, m, want+1)
			if _, err := Parse(over, formats); err == nil {
				t.Fatalf("%s: should not parse", over)
			}
		}
	}
}

// TestBoundaryYearStrings pins the extreme representable years.
func TestBoundaryYearStrings(t *testing.T) {
	for _, in := range []string{"0000-01-01", "9999-12-31", "0000-02-29", "1900-02-28", "2000-02-29"} {
		if _, err := Parse(in, []string{"2006-01-02"}); err != nil {
			t.Errorf("%s: %v", in, err)
		}
	}
	for _, in := range []string{"0000-02-30", "1900-02-29", "2100-02-29"} {
		if _, err := Parse(in, []string{"2006-01-02"}); err == nil {
			t.Errorf("%s: should not parse", in)
		}
	}
}
