package dataeng

import (
	"fmt"
	"time"
)

// FiscalMonthCalendar generates calendar-month intervals labeled by fiscal
// year and fiscal month. The fiscal year begins on the first day of
// YearStartMonth; labels use the calendar year in which the fiscal year
// begins (e.g. with YearStartMonth == July, February 2026 is FY2025-M08).
type FiscalMonthCalendar struct {
	Loc *time.Location
	// YearStartMonth is the first month of the fiscal year (1-12).
	YearStartMonth time.Month
}

// NewFiscalMonthCalendar returns a FiscalMonthCalendar. It panics if
// startMonth is outside [1, 12]. A nil loc means UTC.
func NewFiscalMonthCalendar(loc *time.Location, startMonth time.Month) FiscalMonthCalendar {
	if startMonth < time.January || startMonth > time.December {
		panic(fmt.Sprintf("dataeng: invalid fiscal year start month %d", startMonth))
	}
	if loc == nil {
		loc = time.UTC
	}
	return FiscalMonthCalendar{Loc: loc, YearStartMonth: startMonth}
}

func (c FiscalMonthCalendar) gen() generator {
	return generator{
		loc: c.Loc,
		floor: func(t time.Time) time.Time {
			y, m, _ := t.In(c.Loc).Date()
			return startOfDay(y, m, 1, c.Loc)
		},
		next: func(b time.Time) time.Time {
			y, m, _ := b.In(c.Loc).Date()
			return startOfDay(y, m+1, 1, c.Loc)
		},
	}
}

// Intervals implements Calendar.
func (c FiscalMonthCalendar) Intervals(from, to time.Time) []Interval {
	return c.gen().intervals(from, to)
}

// IsBoundary implements Calendar.
func (c FiscalMonthCalendar) IsBoundary(t time.Time) bool {
	return c.gen().isBoundary(t)
}

// FiscalYearMonth returns the fiscal year and 1-based fiscal month
// containing t.
func (c FiscalMonthCalendar) FiscalYearMonth(t time.Time) (fy, fm int) {
	y, m, _ := t.In(c.Loc).Date()
	if m < c.YearStartMonth {
		y--
	}
	fm = mod(int(m)-int(c.YearStartMonth), 12) + 1
	return y, fm
}

// Label returns e.g. "FY2025-M08".
func (c FiscalMonthCalendar) Label(start time.Time) string {
	fy, fm := c.FiscalYearMonth(start)
	return fmt.Sprintf("FY%04d-M%02d", fy, fm)
}
