// Package dateparse parses dates from text against a caller-supplied set of
// reference-time formats.
//
// The package follows an explicit proleptic Gregorian calendar: a year is a
// leap year iff it is divisible by 4, except centuries, which must be
// divisible by 400. Day-of-month validation uses these rules directly rather
// than relying on normalization.
//
// When several formats match but produce different dates, Parse reports an
// *AmbiguityError instead of guessing (for example it will not decide whether
// "03/04/2025" means March 4 or April 3). Leap seconds (a seconds value of
// 60) are rejected with a *LeapSecondError. Time zone offsets are reported as
// integer minutes east of UTC.
//
// Formats use a subset of the Go reference-time layout syntax: 2006, 06, 01,
// 1, Jan, January, 02, 2, _2, 15, 03, 3, 04, 4, 05, 5, PM, pm, -07:00, -0700,
// -07, Z07:00, Z0700 and Z07. Every format must contain a year, a month and a
// day token; all other bytes are matched literally.
package dateparse

import (
	"fmt"
	"strings"
	"time"
)

// Date is a parsed calendar date with optional clock time and zone offset.
type Date struct {
	Year, Month, Day     int
	Hour, Minute, Second int
	HasTime              bool // true when the format contained clock tokens
	OffsetMinutes        int  // minutes east of UTC
	HasOffset            bool // true when the format contained a zone token
}

// Time converts the Date to a time.Time. When the Date carries a zone offset
// a fixed zone of OffsetMinutes is used; otherwise the wall-clock fields are
// interpreted as UTC.
func (d Date) Time() time.Time {
	loc := time.UTC
	if d.HasOffset {
		loc = time.FixedZone("", d.OffsetMinutes*60)
	}
	return time.Date(d.Year, time.Month(d.Month), d.Day, d.Hour, d.Minute, d.Second, 0, loc)
}

func (d Date) String() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%04d-%02d-%02d", d.Year, d.Month, d.Day)
	if d.HasTime {
		fmt.Fprintf(&b, " %02d:%02d:%02d", d.Hour, d.Minute, d.Second)
	}
	if d.HasOffset {
		if d.OffsetMinutes == 0 {
			b.WriteByte('Z')
		} else {
			off := d.OffsetMinutes
			sign := byte('+')
			if off < 0 {
				sign = '-'
				off = -off
			}
			fmt.Fprintf(&b, "%c%02d:%02d", sign, off/60, off%60)
		}
	}
	return b.String()
}

// Candidate describes one format that matched the input.
type Candidate struct {
	Format     string // the layout that matched
	Start, End int    // byte offsets of the matched span within the input
	Date       Date
}

// Text returns the matched substring of input.
func (c Candidate) Text(input string) string { return input[c.Start:c.End] }

// Result is the outcome of an unambiguous parse.
type Result struct {
	Date       Date
	Format     string   // the first (leftmost in the format list) matching format
	Formats    []string // every format that matched and agrees on the date
	Start, End int      // byte offsets of the matched span within the input
}

// Text returns the matched substring of input.
func (r Result) Text(input string) string { return input[r.Start:r.End] }

// Parse scans input for a date matching any of the given formats. Each format
// contributes its leftmost match; a match is not allowed to start or end in
// the middle of a run of ASCII digits.
//
// If exactly one distinct date results, Parse returns it together with the
// matched format(s) and the matched span. If different formats yield
// different dates, Parse returns an *AmbiguityError rather than guessing. If
// no format matches, it returns a *NoMatchError. A seconds field of 60
// produces a *LeapSecondError.
func Parse(input string, formats []string) (Result, error) {
	if len(formats) == 0 {
		return Result{}, &FormatError{Reason: "at least one format is required"}
	}
	var cands []Candidate
	for _, f := range formats {
		toks := tokenize(f)
		if err := validate(f, toks); err != nil {
			return Result{}, err
		}
		c, ok, err := scan(input, f, toks)
		if err != nil {
			return Result{}, err
		}
		if ok {
			cands = append(cands, c)
		}
	}
	if len(cands) == 0 {
		return Result{}, &NoMatchError{Input: input, Formats: formats}
	}
	key := instantKey(cands[0].Date)
	agreeing := []string{cands[0].Format}
	ambiguous := false
	for _, c := range cands[1:] {
		if instantKey(c.Date) == key {
			agreeing = append(agreeing, c.Format)
		} else {
			ambiguous = true
		}
	}
	if ambiguous {
		return Result{}, &AmbiguityError{Input: input, Candidates: cands}
	}
	first := cands[0]
	return Result{
		Date:    first.Date,
		Format:  first.Format,
		Formats: agreeing,
		Start:   first.Start,
		End:     first.End,
	}, nil
}

// instantKey normalizes a Date to its UTC wall-clock fields so that two
// candidates describing the same instant compare equal.
func instantKey(d Date) string {
	return d.Time().UTC().Format("2006-01-02T15:04:05")
}

// isLeap reports whether year y is a leap year under the explicit Gregorian
// rule: divisible by 4, except centuries, which must be divisible by 400.
func isLeap(y int) bool {
	return y%4 == 0 && (y%100 != 0 || y%400 == 0)
}

// daysIn returns the number of days in month m of year y (proleptic
// Gregorian). m must be in [1, 12].
func daysIn(y, m int) int {
	switch m {
	case 1, 3, 5, 7, 8, 10, 12:
		return 31
	case 4, 6, 9, 11:
		return 30
	case 2:
		if isLeap(y) {
			return 29
		}
		return 28
	}
	return 0
}

var (
	monthNames = []string{"january", "february", "march", "april", "may", "june",
		"july", "august", "september", "october", "november", "december"}
	monthAbbr = []string{"jan", "feb", "mar", "apr", "may", "jun",
		"jul", "aug", "sep", "oct", "nov", "dec"}
)

type state struct {
	year, month, day int
	hour, min, sec   int
	hasTime          bool
	offset           int
	hasOffset        bool
	pmSeen, pm       bool
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

func fixedDigits(s string, pos, width int) (int, bool) {
	if pos+width > len(s) {
		return 0, false
	}
	v := 0
	for i := 0; i < width; i++ {
		c := s[pos+i]
		if !isDigit(c) {
			return 0, false
		}
		v = v*10 + int(c-'0')
	}
	return v, true
}

// scan finds the leftmost acceptable match of toks in input.
func scan(input, format string, toks []token) (Candidate, bool, error) {
	for start := 0; start <= len(input); start++ {
		if start > 0 && isNumericKind(toks[0].kind) && isDigit(input[start-1]) {
			continue // do not start a match in the middle of a digit run
		}
		st, end, ok, err := matchAll(toks, input, start, state{})
		if err != nil {
			if lse, ok2 := err.(*LeapSecondError); ok2 {
				lse.Format = format
				lse.Start = start
			}
			return Candidate{}, false, err
		}
		if !ok {
			continue
		}
		if end < len(input) && isNumericKind(toks[len(toks)-1].kind) && isDigit(input[end]) {
			continue // do not end a match in the middle of a digit run
		}
		if st.day < 1 || st.day > daysIn(st.year, st.month) {
			continue // not a valid Gregorian date; keep scanning
		}
		d := Date{
			Year: st.year, Month: st.month, Day: st.day,
			Hour: st.hour, Minute: st.min, Second: st.sec,
			HasTime:       st.hasTime,
			OffsetMinutes: st.offset,
			HasOffset:     st.hasOffset,
		}
		return Candidate{Format: format, Start: start, End: end, Date: d}, true, nil
	}
	return Candidate{}, false, nil
}

// matchAll tries to consume all tokens starting at pos. It returns the final
// state and the end offset on success. A seconds value of 60 is a hard
// *LeapSecondError; anything else that does not match simply returns ok=false.
func matchAll(toks []token, s string, pos int, st state) (state, int, bool, error) {
	if len(toks) == 0 {
		if st.sec == 60 {
			return st, 0, false, &LeapSecondError{End: pos}
		}
		if st.pmSeen {
			if st.pm {
				if st.hour != 12 {
					st.hour += 12
				}
			} else if st.hour == 12 {
				st.hour = 0
			}
		}
		return st, pos, true, nil
	}
	tok := toks[0]
	rest := toks[1:]

	setNum := func(v int, assign func(*state, int)) (state, int, bool, error) {
		assign(&st, v)
		return matchAll(rest, s, pos, st)
	}
	numFixed := func(width, lo, hi int, assign func(*state, int)) (state, int, bool, error) {
		v, ok := fixedDigits(s, pos, width)
		if !ok || v < lo || v > hi {
			return st, 0, false, nil
		}
		pos += width
		return setNum(v, assign)
	}
	numVar := func(lo, hi int, assign func(*state, int)) (state, int, bool, error) {
		for w := 2; w >= 1; w-- {
			if v, ok := fixedDigits(s, pos, w); ok && v >= lo && v <= hi {
				st2, end, ok2, err := matchAll(rest, s, pos+w, func() state { a := st; assign(&a, v); return a }())
				if ok2 || err != nil {
					return st2, end, ok2, err
				}
			}
		}
		return st, 0, false, nil
	}

	switch tok.kind {
	case kLiteral:
		if strings.HasPrefix(s[pos:], tok.lit) {
			return matchAll(rest, s, pos+len(tok.lit), st)
		}
	case kYear4:
		return numFixed(4, 0, 9999, func(st *state, v int) { st.year = v })
	case kYear2:
		return numFixed(2, 0, 99, func(st *state, v int) {
			// Same pivot as the Go standard library: 69-99 map to
			// 1969-1999, 00-68 map to 2000-2068.
			if v <= 68 {
				st.year = 2000 + v
			} else {
				st.year = 1900 + v
			}
		})
	case kMonthNum:
		return numFixed(2, 1, 12, func(st *state, v int) { st.month = v })
	case kMonthNumNoPad:
		return numVar(1, 12, func(st *state, v int) { st.month = v })
	case kMonthShort:
		for i, ab := range monthAbbr {
			if pos+3 <= len(s) && strings.EqualFold(s[pos:pos+3], ab) {
				st2 := st
				st2.month = i + 1
				if st3, end, ok, err := matchAll(rest, s, pos+3, st2); ok || err != nil {
					return st3, end, ok, err
				}
			}
		}
	case kMonthLong:
		for i, name := range monthNames {
			if pos+len(name) <= len(s) && strings.EqualFold(s[pos:pos+len(name)], name) {
				st2 := st
				st2.month = i + 1
				if st3, end, ok, err := matchAll(rest, s, pos+len(name), st2); ok || err != nil {
					return st3, end, ok, err
				}
			}
		}
	case kDay:
		return numFixed(2, 1, 31, func(st *state, v int) { st.day = v })
	case kDayNoPad:
		return numVar(1, 31, func(st *state, v int) { st.day = v })
	case kDaySpace:
		if pos < len(s) && s[pos] == ' ' {
			pos++
		}
		return numVar(1, 31, func(st *state, v int) { st.day = v })
	case kHour24:
		return numFixed(2, 0, 23, func(st *state, v int) { st.hour, st.hasTime = v, true })
	case kHour12:
		return numFixed(2, 1, 12, func(st *state, v int) { st.hour, st.hasTime = v, true })
	case kHour12NoPad:
		return numVar(1, 12, func(st *state, v int) { st.hour, st.hasTime = v, true })
	case kMin:
		return numFixed(2, 0, 59, func(st *state, v int) { st.min, st.hasTime = v, true })
	case kMinNoPad:
		return numVar(0, 59, func(st *state, v int) { st.min, st.hasTime = v, true })
	case kSec:
		// 60 is accepted here and rejected as a leap second once the
		// whole format matches; 61+ is simply out of range.
		return numFixed(2, 0, 60, func(st *state, v int) { st.sec, st.hasTime = v, true })
	case kSecNoPad:
		return numVar(0, 60, func(st *state, v int) { st.sec, st.hasTime = v, true })
	case kPM:
		// Like the Go standard library, the "PM" token accepts
		// either "AM" or "PM" in the input.
		if strings.HasPrefix(s[pos:], "PM") {
			st.pmSeen, st.pm = true, true
			return matchAll(rest, s, pos+2, st)
		}
		if strings.HasPrefix(s[pos:], "AM") {
			st.pmSeen, st.pm = true, false
			return matchAll(rest, s, pos+2, st)
		}
	case kPMLower:
		if strings.HasPrefix(s[pos:], "pm") {
			st.pmSeen, st.pm = true, true
			return matchAll(rest, s, pos+2, st)
		}
		if strings.HasPrefix(s[pos:], "am") {
			st.pmSeen, st.pm = true, false
			return matchAll(rest, s, pos+2, st)
		}
	case kZoneColon, kZoneCompact, kZoneHour, kZoneZColon, kZoneZCompact, kZoneZHour:
		zoned := tok.kind >= kZoneZColon
		if zoned && pos < len(s) && s[pos] == 'Z' {
			st2 := st
			st2.offset, st2.hasOffset = 0, true
			if st3, end, ok, err := matchAll(rest, s, pos+1, st2); ok || err != nil {
				return st3, end, ok, err
			}
		}
		if pos < len(s) && (s[pos] == '+' || s[pos] == '-') {
			sign := 1
			if s[pos] == '-' {
				sign = -1
			}
			if hh, ok := fixedDigits(s, pos+1, 2); ok && hh <= 23 {
				p := pos + 3
				mm := 0
				valid := true
				switch tok.kind {
				case kZoneColon, kZoneZColon:
					if p < len(s) && s[p] == ':' {
						p++
					} else {
						valid = false
					}
					if valid {
						if v, ok := fixedDigits(s, p, 2); ok {
							mm = v
							p += 2
						} else {
							valid = false
						}
					}
				case kZoneCompact, kZoneZCompact:
					if v, ok := fixedDigits(s, p, 2); ok {
						mm = v
						p += 2
					} else {
						valid = false
					}
				}
				if valid && mm <= 59 {
					st.offset = sign * (hh*60 + mm)
					st.hasOffset = true
					return matchAll(rest, s, p, st)
				}
			}
		}
	}
	return st, 0, false, nil
}
