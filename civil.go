package dataeng

import "time"

// daysFromCivil converts a civil date to a count of days since 1970-01-01
// (Howard Hinnant's algorithm). It is location-independent and therefore
// immune to DST when measuring distances between civil dates.
func daysFromCivil(y int, m time.Month, d int) int {
	yy := y
	mm := int(m)
	if mm <= 2 {
		yy--
	}
	era := floorDiv(yy, 400)
	yoe := yy - era*400
	mp := mod(mm-3, 12)
	doy := (153*mp+2)/5 + d - 1
	doe := yoe*365 + yoe/4 - yoe/100 + doy
	return era*146097 + doe - 719468
}

// civilFromDays is the inverse of daysFromCivil.
func civilFromDays(z int) (int, time.Month, int) {
	z += 719468
	era := floorDiv(z, 146097)
	doe := z - era*146097
	yoe := (doe - doe/1460 + doe/36524 - doe/146096) / 365
	y := yoe + era*400
	doy := doe - (365*yoe + yoe/4 - yoe/100)
	mp := (5*doy + 2) / 153
	d := doy - (153*mp+2)/5 + 1
	m := mp + 3
	if mp >= 10 {
		m = mp - 9
	}
	if m <= 2 {
		y++
	}
	return y, time.Month(m), d
}

// weekdayOfDays returns the weekday of a civil day count, with Sunday == 0.
func weekdayOfDays(z int) time.Weekday {
	// 1970-01-01 (z == 0) was a Thursday.
	return time.Weekday(mod(z+4, 7))
}

func floorDiv(a, b int) int {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return q
}

func mod(a, n int) int {
	r := a % n
	if r < 0 {
		r += n
	}
	return r
}

// startOfDay returns the first instant of the civil date y-m-d in loc.
//
// If midnight does not exist on that date (a DST gap at 00:00), the first
// valid instant of the date is returned. If the entire civil date is skipped
// (e.g. Pacific/Apia on 2011-12-30), the first instant following the skipped
// date is returned, so the preceding period simply absorbs the missing day.
func startOfDay(y int, m time.Month, d int, loc *time.Location) time.Time {
	target := daysFromCivil(y, m, d)
	t := time.Date(y, m, d, 0, 0, 0, 0, loc)
	// A skipped civil date spans at most 24h; 48 iterations is ample.
	for i := 0; i < 48; i++ {
		cy, cm, cd := t.In(loc).Date()
		if daysFromCivil(cy, cm, cd) >= target {
			return t
		}
		t = t.Add(time.Hour)
	}
	return t
}

// startOfCivilDay is startOfDay expressed in civil-day counts.
func startOfCivilDay(z int, loc *time.Location) time.Time {
	y, m, d := civilFromDays(z)
	return startOfDay(y, m, d, loc)
}
