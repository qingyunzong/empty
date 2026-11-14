package dataeng

import "time"

// DayCalendar generates natural-day intervals in a time zone. A day spans
// from local midnight to the next local midnight, so its duration is 23h or
// 25h across DST transitions rather than a fixed 24h.
type DayCalendar struct {
	Loc *time.Location
}

// NewDayCalendar returns a DayCalendar for loc. A nil loc means UTC.
func NewDayCalendar(loc *time.Location) DayCalendar {
	if loc == nil {
		loc = time.UTC
	}
	return DayCalendar{Loc: loc}
}

func (c DayCalendar) gen() generator {
	return generator{
		loc: c.Loc,
		floor: func(t time.Time) time.Time {
			y, m, d := t.In(c.Loc).Date()
			return startOfDay(y, m, d, c.Loc)
		},
		next: func(b time.Time) time.Time {
			y, m, d := b.In(c.Loc).Date()
			n := startOfDay(y, m, d+1, c.Loc)
			if !n.After(b) {
				// The next civil date is entirely skipped in this zone.
				n = startOfDay(y, m, d+2, c.Loc)
			}
			return n
		},
	}
}

// Intervals implements Calendar.
func (c DayCalendar) Intervals(from, to time.Time) []Interval {
	return c.gen().intervals(from, to)
}

// IsBoundary implements Calendar.
func (c DayCalendar) IsBoundary(t time.Time) bool {
	return c.gen().isBoundary(t)
}

// Label returns the civil date of the day, e.g. "2026-03-08".
func (c DayCalendar) Label(start time.Time) string {
	return start.In(c.Loc).Format("2006-01-02")
}
