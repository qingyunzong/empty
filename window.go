package dataeng

import "time"

// WindowSpec slices event time into tumbling windows anchored to a business
// timezone. A 24h window in Asia/Shanghai therefore runs local midnight to
// local midnight, not UTC midnight to UTC midnight.
type WindowSpec struct {
	Size     time.Duration
	Location *time.Location
}

func (w WindowSpec) loc() *time.Location {
	if w.Location != nil {
		return w.Location
	}
	return time.UTC
}

// Start returns the inclusive start instant of the window containing t.
func (w WindowSpec) Start(t time.Time) time.Time {
	loc := w.loc()
	lt := t.In(loc)
	y, m, d := lt.Date()
	midnight := time.Date(y, m, d, 0, 0, 0, 0, loc)
	if w.Size >= 24*time.Hour && w.Size%(24*time.Hour) == 0 {
		// Calendar-day windows follow local midnights so DST shifts do not
		// drift the boundary.
		days := int(w.Size / (24 * time.Hour))
		ordinal := int(time.Date(y, m, d, 0, 0, 0, 0, time.UTC).Unix() / 86400)
		startOrdinal := ordinal / days * days
		sy, sm, sd := time.Unix(int64(startOrdinal)*86400, 0).UTC().Date()
		return time.Date(sy, sm, sd, 0, 0, 0, 0, loc)
	}
	return midnight.Add(lt.Sub(midnight) / w.Size * w.Size)
}

// End returns the exclusive end instant of the window that starts at start.
func (w WindowSpec) End(start time.Time) time.Time {
	end := w.Start(start.Add(w.Size))
	for !end.After(start) {
		end = w.Start(end.Add(w.Size))
	}
	return end
}
