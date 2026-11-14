package dataeng

import (
	"fmt"
	"time"
)

// WeekCalendar generates weekly intervals starting on WeekStart at local
// midnight. Use NewISOWeekCalendar for ISO 8601 weeks (Monday start).
type WeekCalendar struct {
	Loc       *time.Location
	WeekStart time.Weekday
}

// NewISOWeekCalendar returns a WeekCalendar with ISO 8601 Monday-start
// weeks. A nil loc means UTC.
func NewISOWeekCalendar(loc *time.Location) WeekCalendar {
	if loc == nil {
		loc = time.UTC
	}
	return WeekCalendar{Loc: loc, WeekStart: time.Monday}
}

func (c WeekCalendar) gen() generator {
	return generator{
		loc: c.Loc,
		floor: func(t time.Time) time.Time {
			y, m, d := t.In(c.Loc).Date()
			z := daysFromCivil(y, m, d)
			back := mod(int(weekdayOfDays(z))-int(c.WeekStart), 7)
			return startOfCivilDay(z-back, c.Loc)
		},
		next: func(b time.Time) time.Time {
			y, m, d := b.In(c.Loc).Date()
			return startOfDay(y, m, d+7, c.Loc)
		},
	}
}

// Intervals implements Calendar.
func (c WeekCalendar) Intervals(from, to time.Time) []Interval {
	return c.gen().intervals(from, to)
}

// IsBoundary implements Calendar.
func (c WeekCalendar) IsBoundary(t time.Time) bool {
	return c.gen().isBoundary(t)
}

// Label returns the ISO week label "2006-W02" for Monday-start calendars,
// or the civil start date for other week starts.
func (c WeekCalendar) Label(start time.Time) string {
	if c.WeekStart == time.Monday {
		y, w := start.In(c.Loc).ISOWeek()
		return fmt.Sprintf("%04d-W%02d", y, w)
	}
	return start.In(c.Loc).Format("2006-01-02")
}
