package rollup

// Calendar maps explicit integer days to week indexes. It never consults
// the system clock or timezone: days are opaque integers supplied by the
// caller, and weeks are derived purely from WeekOrigin.
type Calendar struct {
	// WeekOrigin is the integer day on which week 0 begins.
	WeekOrigin int
}

// Week returns the index of the 7-day week containing day, where the week
// starting at WeekOrigin is week 0. Days before the origin yield negative
// week indexes via floor division.
func (c Calendar) Week(day int) int {
	return floorDiv(day-c.WeekOrigin, 7)
}

func floorDiv(a, b int) int {
	q := a / b
	if a%b != 0 && (a < 0) != (b < 0) {
		q--
	}
	return q
}
