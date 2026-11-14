package dataeng

import (
	"fmt"
	"time"
)

// AnchorMode selects how a retail year start is derived from the anchor date.
type AnchorMode int

const (
	// Nearest picks the WeekStart closest to the anchor date; ties resolve
	// to the earlier candidate. With anchor February 1 and WeekStart
	// Sunday this reproduces the NRF 4-5-4 calendar.
	Nearest AnchorMode = iota
	// OnOrAfter picks the first WeekStart on or after the anchor date.
	OnOrAfter
	// OnOrBefore picks the last WeekStart on or before the anchor date.
	OnOrBefore
)

// Retail445Calendar generates retail (4-4-5 style) periods. Each retail
// year is divided into four quarters; every quarter follows Pattern weeks
// per period (default {4, 4, 5}).
//
// A retail year starts on the WeekStart weekday derived from the anchor
// date (AnchorMonth/AnchorDay) via Mode. Whether a year has 52 or 53 weeks
// follows from that rule; a 53-week (leap) year adds its extra week to the
// final period of the year. LeapYears may instead pin the set of 53-week
// retail years explicitly.
type Retail445Calendar struct {
	Loc *time.Location
	// WeekStart is the weekday periods begin on (e.g. time.Sunday).
	WeekStart time.Weekday
	// AnchorMonth and AnchorDay define the reference date used to derive
	// each retail year start (e.g. February 1 for the NRF calendar).
	AnchorMonth time.Month
	AnchorDay   int
	Mode        AnchorMode
	// Pattern lists the weeks per period within a quarter. The zero value
	// means {4, 4, 5}.
	Pattern [3]int
	// LeapYears, when non-nil, overrides the rule-based leap week
	// determination: years present with value true have 53 weeks.
	LeapYears map[int]bool
}

// NewRetail445Calendar returns a Retail445Calendar with the default {4,4,5}
// pattern. It panics on an invalid anchor date. A nil loc means UTC.
func NewRetail445Calendar(loc *time.Location, weekStart time.Weekday,
	anchorMonth time.Month, anchorDay int, mode AnchorMode) Retail445Calendar {
	if anchorMonth < time.January || anchorMonth > time.December ||
		anchorDay < 1 || anchorDay > 31 {
		panic(fmt.Sprintf("dataeng: invalid retail anchor %d-%d", anchorMonth, anchorDay))
	}
	if loc == nil {
		loc = time.UTC
	}
	return Retail445Calendar{
		Loc:         loc,
		WeekStart:   weekStart,
		AnchorMonth: anchorMonth,
		AnchorDay:   anchorDay,
		Mode:        mode,
		Pattern:     [3]int{4, 4, 5},
	}
}

func (c Retail445Calendar) pattern() [3]int {
	if c.Pattern == ([3]int{}) {
		return [3]int{4, 4, 5}
	}
	return c.Pattern
}

// yearStartDays returns the civil day count of the first day of retail
// year y.
func (c Retail445Calendar) yearStartDays(y int) int {
	ref := daysFromCivil(y, c.AnchorMonth, c.AnchorDay)
	wd := int(weekdayOfDays(ref))
	target := int(c.WeekStart)
	switch c.Mode {
	case OnOrAfter:
		return ref + mod(target-wd, 7)
	case OnOrBefore:
		return ref - mod(wd-target, 7)
	default: // Nearest
		back := mod(wd-target, 7)
		fwd := mod(target-wd, 7)
		if fwd < back {
			return ref + fwd
		}
		return ref - back
	}
}

// weeksInYear returns 52 or 53 for retail year y.
func (c Retail445Calendar) weeksInYear(y int) int {
	if c.LeapYears != nil {
		if c.LeapYears[y] {
			return 53
		}
		return 52
	}
	return (c.yearStartDays(y+1) - c.yearStartDays(y)) / 7
}

// periodOffsets returns the 13 period boundaries of retail year y as week
// offsets from the year start (offsets[12] == weeksInYear(y)).
func (c Retail445Calendar) periodOffsets(y int) [13]int {
	var offsets [13]int
	p := c.pattern()
	acc := 0
	i := 0
	for q := 0; q < 4; q++ {
		for k := 0; k < 3; k++ {
			offsets[i] = acc
			acc += p[k]
			i++
		}
	}
	offsets[12] = c.weeksInYear(y)
	return offsets
}

// locate finds the retail year and period index containing civil day z.
func (c Retail445Calendar) locate(z int) (year, period int, offsets [13]int, yearStart int) {
	year = civilYearApprox(z)
	yearStart = c.yearStartDays(year)
	if z < yearStart {
		year--
		yearStart = c.yearStartDays(year)
	} else if next := c.yearStartDays(year + 1); z >= next {
		year++
		yearStart = next
	}
	offsets = c.periodOffsets(year)
	week := (z - yearStart) / 7
	period = 0
	for i := 1; i <= 12; i++ {
		if offsets[i] > week {
			break
		}
		period = i
	}
	return year, period, offsets, yearStart
}

// civilYearApprox returns the calendar year of a civil day count.
func civilYearApprox(z int) int {
	y, _, _ := civilFromDays(z)
	return y
}

func (c Retail445Calendar) gen() generator {
	return generator{
		loc: c.Loc,
		floor: func(t time.Time) time.Time {
			y, m, d := t.In(c.Loc).Date()
			_, period, offsets, yearStart := c.locate(daysFromCivil(y, m, d))
			return startOfCivilDay(yearStart+offsets[period]*7, c.Loc)
		},
		next: func(b time.Time) time.Time {
			y, m, d := b.In(c.Loc).Date()
			year, period, offsets, yearStart := c.locate(daysFromCivil(y, m, d))
			if period == 12 {
				return startOfCivilDay(c.yearStartDays(year+1), c.Loc)
			}
			return startOfCivilDay(yearStart+offsets[period+1]*7, c.Loc)
		},
	}
}

// Intervals implements Calendar.
func (c Retail445Calendar) Intervals(from, to time.Time) []Interval {
	return c.gen().intervals(from, to)
}

// IsBoundary implements Calendar.
func (c Retail445Calendar) IsBoundary(t time.Time) bool {
	return c.gen().isBoundary(t)
}

// Label returns e.g. "RY2023-P12".
func (c Retail445Calendar) Label(start time.Time) string {
	y, m, d := start.In(c.Loc).Date()
	year, period, _, _ := c.locate(daysFromCivil(y, m, d))
	return fmt.Sprintf("RY%04d-P%02d", year, period+1)
}
