package dataeng

import (
	"fmt"
	"testing"
	"time"
)

func mustLoc(t *testing.T, name string) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation(name)
	if err != nil {
		t.Fatalf("load location %s: %v", name, err)
	}
	return loc
}

// assertPartition verifies seamless adjacency and full coverage of [from, to).
func assertPartition(t *testing.T, ivs []Interval, from, to time.Time) {
	t.Helper()
	if len(ivs) == 0 {
		t.Fatalf("no intervals for [%s, %s)", from, to)
	}
	if !ivs[0].Start.Equal(from) {
		t.Errorf("first interval starts at %s, want %s", ivs[0].Start, from)
	}
	if !ivs[len(ivs)-1].End.Equal(to) {
		t.Errorf("last interval ends at %s, want %s", ivs[len(ivs)-1].End, to)
	}
	for i, iv := range ivs {
		if !iv.Start.Before(iv.End) {
			t.Errorf("interval %d is empty or inverted: %s", i, iv)
		}
		if i > 0 && !ivs[i-1].End.Equal(iv.Start) {
			t.Errorf("gap/overlap between intervals %d and %d: %s vs %s",
				i-1, i, ivs[i-1].End, iv.Start)
		}
	}
}

func findByLabel(t *testing.T, c Calendar, ivs []Interval, label string) Interval {
	t.Helper()
	for _, iv := range ivs {
		if c.Label(iv.Start) == label {
			return iv
		}
	}
	t.Fatalf("no interval labeled %s", label)
	return Interval{}
}

func TestDayCalendarDST(t *testing.T) {
	ny := mustLoc(t, "America/New_York")
	cal := NewDayCalendar(ny)

	// 2026-03-08 is the US spring-forward day: 23 hours.
	from := time.Date(2026, 3, 6, 0, 0, 0, 0, ny)
	to := time.Date(2026, 3, 11, 0, 0, 0, 0, ny)
	ivs := cal.Intervals(from, to)
	assertPartition(t, ivs, from, to)
	if got := findByLabel(t, cal, ivs, "2026-03-08").Duration(); got != 23*time.Hour {
		t.Errorf("spring-forward day = %v, want 23h", got)
	}
	if got := findByLabel(t, cal, ivs, "2026-03-07").Duration(); got != 24*time.Hour {
		t.Errorf("regular day = %v, want 24h", got)
	}

	// 2026-11-01 is the US fall-back day: 25 hours.
	from = time.Date(2026, 10, 31, 0, 0, 0, 0, ny)
	to = time.Date(2026, 11, 3, 0, 0, 0, 0, ny)
	ivs = cal.Intervals(from, to)
	assertPartition(t, ivs, from, to)
	if got := findByLabel(t, cal, ivs, "2026-11-01").Duration(); got != 25*time.Hour {
		t.Errorf("fall-back day = %v, want 25h", got)
	}
}

func TestDayCalendarSkippedDate(t *testing.T) {
	// Pacific/Apia skipped 2011-12-30 entirely.
	apia := mustLoc(t, "Pacific/Apia")
	cal := NewDayCalendar(apia)
	from := time.Date(2011, 12, 28, 0, 0, 0, 0, apia)
	to := time.Date(2012, 1, 2, 0, 0, 0, 0, apia)
	ivs := cal.Intervals(from, to)
	assertPartition(t, ivs, from, to)
	for _, iv := range ivs {
		if cal.Label(iv.Start) == "2011-12-30" {
			t.Errorf("skipped date 2011-12-30 produced an interval")
		}
	}
}

func TestISOWeekCalendar(t *testing.T) {
	ny := mustLoc(t, "America/New_York")
	cal := NewISOWeekCalendar(ny)
	from := time.Date(2026, 1, 1, 0, 0, 0, 0, ny)
	to := time.Date(2026, 2, 2, 0, 0, 0, 0, ny)
	ivs := cal.Intervals(from, to)
	assertPartition(t, ivs, from, to)

	// 2026-01-01 is a Thursday in ISO week 2026-W01; the week starts
	// Monday 2025-12-29, so the first interval is clipped to `from`.
	if got := cal.Label(ivs[1].Start); got != "2026-W02" {
		t.Errorf("second interval label = %s, want 2026-W02", got)
	}
	for _, iv := range ivs[1 : len(ivs)-1] {
		if wd := iv.Start.In(ny).Weekday(); wd != time.Monday {
			t.Errorf("week boundary %s is a %s, want Monday", iv.Start, wd)
		}
		if h, m, s := iv.Start.In(ny).Clock(); h != 0 || m != 0 || s != 0 {
			t.Errorf("week boundary %s is not at local midnight", iv.Start)
		}
	}
}

func TestFiscalMonthCalendar(t *testing.T) {
	cal := NewFiscalMonthCalendar(time.UTC, time.July)
	from := time.Date(2026, 1, 15, 12, 0, 0, 0, time.UTC)
	to := time.Date(2026, 4, 15, 12, 0, 0, 0, time.UTC)
	ivs := cal.Intervals(from, to)
	assertPartition(t, ivs, from, to)

	wantLabels := []string{"FY2025-M07", "FY2025-M08", "FY2025-M09", "FY2025-M10"}
	if len(ivs) != len(wantLabels) {
		t.Fatalf("got %d intervals, want %d", len(ivs), len(wantLabels))
	}
	for i, want := range wantLabels {
		if got := cal.Label(ivs[i].Start); got != want {
			t.Errorf("interval %d label = %s, want %s", i, got, want)
		}
	}
	// Untruncated boundaries fall on the first of the month.
	if ivs[1].Start.Day() != 1 || ivs[1].Start.Month() != time.February {
		t.Errorf("boundary = %s, want 2026-02-01", ivs[1].Start)
	}
}

func nrfCalendar(loc *time.Location) Retail445Calendar {
	// NRF 4-5-4: retail year starts on the Sunday nearest February 1.
	return NewRetail445Calendar(loc, time.Sunday, time.February, 1, Nearest)
}

func TestRetail445Calendar(t *testing.T) {
	cal := nrfCalendar(time.UTC)
	from := time.Date(2023, 1, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	ivs := cal.Intervals(from, to)
	assertPartition(t, ivs, from, to)

	weeks := func(label string) float64 {
		return findByLabel(t, cal, ivs, label).Duration().Hours() / 24 / 7
	}

	// RY2023 starts Sunday 2023-01-29 and is a 53-week leap year.
	p1 := findByLabel(t, cal, ivs, "RY2023-P01")
	if want := time.Date(2023, 1, 29, 0, 0, 0, 0, time.UTC); !p1.Start.Equal(want) {
		t.Errorf("RY2023-P01 starts %s, want %s", p1.Start, want)
	}
	if got := weeks("RY2023-P01"); got != 4 {
		t.Errorf("RY2023-P01 = %.0f weeks, want 4", got)
	}
	if got := weeks("RY2023-P03"); got != 5 {
		t.Errorf("RY2023-P03 = %.0f weeks, want 5", got)
	}
	if got := weeks("RY2023-P12"); got != 6 {
		t.Errorf("RY2023-P12 (leap) = %.0f weeks, want 6", got)
	}

	// RY2024 starts Sunday 2024-02-04 and is a regular 52-week year.
	p1 = findByLabel(t, cal, ivs, "RY2024-P01")
	if want := time.Date(2024, 2, 4, 0, 0, 0, 0, time.UTC); !p1.Start.Equal(want) {
		t.Errorf("RY2024-P01 starts %s, want %s", p1.Start, want)
	}
	if got := weeks("RY2024-P12"); got != 5 {
		t.Errorf("RY2024-P12 = %.0f weeks, want 5", got)
	}

	// Every boundary falls on the configured week start.
	for _, iv := range ivs[1 : len(ivs)-1] {
		if wd := iv.Start.Weekday(); wd != time.Sunday {
			t.Errorf("period boundary %s is a %s, want Sunday", iv.Start, wd)
		}
	}
}

func TestRetail445ExplicitLeapYears(t *testing.T) {
	cal := nrfCalendar(time.UTC)
	// Pin 2024 as a leap year, overriding the rule-based 52 weeks.
	cal.LeapYears = map[int]bool{2024: true}
	from := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	ivs := cal.Intervals(from, to)
	assertPartition(t, ivs, from, to)
	iv := findByLabel(t, cal, ivs, "RY2024-P12")
	if got := iv.Duration().Hours() / 24 / 7; got != 6 {
		t.Errorf("pinned leap RY2024-P12 = %.0f weeks, want 6", got)
	}
}

// TestSplitMergeConsistency splits the query range at arbitrary instants,
// generates intervals per sub-range, merges them, and requires the result to
// equal the intervals of the unsplit range.
func TestSplitMergeConsistency(t *testing.T) {
	ny := mustLoc(t, "America/New_York")
	cals := map[string]Calendar{
		"day":     NewDayCalendar(ny),
		"isoweek": NewISOWeekCalendar(ny),
		"fiscal":  NewFiscalMonthCalendar(ny, time.April),
		"retail":  nrfCalendar(ny),
	}
	from := time.Date(2025, 6, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2027, 3, 15, 0, 0, 0, 0, time.UTC)

	// Deterministic irregular cut points, including mid-DST-transition ones.
	var cuts []time.Time
	for cur, i := from, 0; ; i++ {
		step := time.Duration(37+(i*53)%41) * time.Hour
		cur = cur.Add(step)
		if !cur.Before(to) {
			break
		}
		cuts = append(cuts, cur)
	}

	for name, cal := range cals {
		t.Run(name, func(t *testing.T) {
			whole := cal.Intervals(from, to)
			assertPartition(t, whole, from, to)

			var parts []Interval
			prev := from
			for _, cut := range append(cuts, to) {
				chunk := cal.Intervals(prev, cut)
				assertPartition(t, chunk, prev, cut)
				parts = append(parts, chunk...)
				prev = cut
			}
			merged, err := MergeSplit(cal, parts)
			if err != nil {
				t.Fatalf("MergeSplit: %v", err)
			}
			if len(merged) != len(whole) {
				t.Fatalf("merged %d intervals, want %d", len(merged), len(whole))
			}
			for i := range whole {
				if !merged[i].Start.Equal(whole[i].Start) || !merged[i].End.Equal(whole[i].End) {
					t.Errorf("interval %d = %s, want %s", i, merged[i], whole[i])
				}
			}
		})
	}
}

// TestPartitionAcrossZones checks seamlessness and coverage over multi-year
// ranges in zones with whole-hour, half-hour and skipped-date transitions.
func TestPartitionAcrossZones(t *testing.T) {
	zones := []string{"America/New_York", "Australia/Lord_Howe", "Pacific/Apia", "Asia/Shanghai"}
	for _, zone := range zones {
		t.Run(zone, func(t *testing.T) {
			loc := mustLoc(t, zone)
			cal := NewDayCalendar(loc)
			from := time.Date(2024, 1, 1, 0, 0, 0, 0, loc)
			to := time.Date(2027, 1, 1, 0, 0, 0, 0, loc)
			ivs := cal.Intervals(from, to)
			assertPartition(t, ivs, from, to)
			for _, iv := range ivs {
				d := iv.Duration()
				if d < 22*time.Hour || d > 26*time.Hour {
					t.Errorf("day %s has implausible duration %v", cal.Label(iv.Start), d)
				}
			}
		})
	}
}

func TestMergeAdjacentErrors(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	gap := []Interval{
		{base, base.Add(time.Hour)},
		{base.Add(2 * time.Hour), base.Add(3 * time.Hour)},
	}
	if _, err := MergeAdjacent(gap); err == nil {
		t.Error("expected error for gapped intervals")
	}
	overlap := []Interval{
		{base, base.Add(2 * time.Hour)},
		{base.Add(time.Hour), base.Add(3 * time.Hour)},
	}
	if _, err := MergeAdjacent(overlap); err == nil {
		t.Error("expected error for overlapping intervals")
	}
	merged := Merge(overlap)
	if len(merged) != 1 || !merged[0].End.Equal(base.Add(3*time.Hour)) {
		t.Errorf("Merge(overlap) = %v, want single [+0h, +3h)", merged)
	}
}

func ExampleDayCalendar() {
	loc, _ := time.LoadLocation("America/New_York")
	cal := NewDayCalendar(loc)
	from := time.Date(2026, 3, 7, 12, 0, 0, 0, loc)
	to := time.Date(2026, 3, 9, 12, 0, 0, 0, loc)
	for _, iv := range cal.Intervals(from, to) {
		fmt.Println(cal.Label(iv.Start), iv.Duration())
	}
	// Output:
	// 2026-03-07 12h0m0s
	// 2026-03-08 23h0m0s
	// 2026-03-09 12h0m0s
}
