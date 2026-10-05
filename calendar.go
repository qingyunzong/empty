// Package rollup maintains daily, weekly, and monthly counts from raw
// events. The calendar is defined purely in terms of explicit integer
// days and a configurable week origin; it never consults the system
// clock or timezone.
package rollup

// Month identifies a civil calendar month by year and month (1-12).
type Month struct {
	Year  int
	Month int
}

// floorDiv returns floor(a/b) for b > 0, correct for negative a.
func floorDiv(a, b int) int {
	q := a / b
	if a%b != 0 && (a < 0) != (b < 0) {
		q--
	}
	return q
}

// WeekIndex returns the index of the week containing day, where week 0
// starts on the explicit weekOrigin day. Works for negative days.
func WeekIndex(day, weekOrigin int) int {
	return floorDiv(day-weekOrigin, 7)
}

// civilFromDays converts an integer day (days since 1970-01-01) into a
// civil year, month, and day of month using pure arithmetic
// (Howard Hinnant's algorithm). No timezone is involved.
func civilFromDays(z int) (year, month, day int) {
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
		y++
	}
	return y, m, d
}

// MonthOf returns the civil calendar month containing the given
// integer day.
func MonthOf(day int) Month {
	y, m, _ := civilFromDays(day)
	return Month{Year: y, Month: m}
}
