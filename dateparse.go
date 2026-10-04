// Package dateparse parses dates against a user-supplied set of formats
// using explicit proleptic Gregorian calendar rules.
//
// Supported format tokens (everything else is a literal):
//
//	YYYY  four-digit year
//	MM    two-digit month (01-12)
//	DD    two-digit day of month
//	HH    two-digit hour (00-23)
//	mm    two-digit minute (00-59)
//	ss    two-digit second (00-59; 60 is a leap second and is rejected)
//	Z     timezone offset "+HH:MM" or "-HH:MM", stored as integer minutes
//
// Parse scans the input left to right and reports the leftmost match. If
// several formats match at the same position but yield different dates,
// an *AmbiguityError is returned; the library never guesses the month/day
// order on its own.
package dateparse

import (
	"errors"
	"fmt"
	"strings"
)

// ErrLeapSecond is returned when a parsed second value is 60.
var ErrLeapSecond = errors.New("dateparse: leap second (60) is not supported")

// ErrNoMatch is returned when no format matches anywhere in the input.
var ErrNoMatch = errors.New("dateparse: no format matched the input")

// Date is a parsed calendar date with optional time and timezone offset.
// OffsetMinutes is the timezone offset east of UTC in integer minutes.
type Date struct {
	Year, Month, Day     int
	Hour, Minute, Second int
	OffsetMinutes        int
	HasTime              bool
	HasOffset            bool
}

// Result describes a successful parse.
type Result struct {
	Date Date
	// MatchedFormats lists every user format that matched and agreed on Date.
	MatchedFormats []string
	// Start and End give the half-open interval [Start, End) of the
	// matched text within the original input string.
	Start, End int
}

// Candidate is one format's interpretation of the input.
type Candidate struct {
	Format string
	Date   Date
}

// AmbiguityError reports that several formats matched the same text but
// produced different dates.
type AmbiguityError struct {
	Input      string
	Start, End int
	Candidates []Candidate
}

func (e *AmbiguityError) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "dateparse: ambiguous input %q at [%d,%d):", e.Input[e.Start:e.End], e.Start, e.End)
	for _, c := range e.Candidates {
		fmt.Fprintf(&b, " format %q -> %04d-%02d-%02d;", c.Format, c.Date.Year, c.Date.Month, c.Date.Day)
	}
	return b.String()
}

// IsLeapYear reports whether year is a leap year under the explicit
// Gregorian rule: divisible by 4, except centuries not divisible by 400.
func IsLeapYear(year int) bool {
	if year%4 != 0 {
		return false
	}
	if year%100 != 0 {
		return true
	}
	return year%400 == 0
}

// DaysInMonth returns the number of days in the given Gregorian month.
// It returns 0 for an out-of-range month.
func DaysInMonth(year, month int) int {
	switch month {
	case 1, 3, 5, 7, 8, 10, 12:
		return 31
	case 4, 6, 9, 11:
		return 30
	case 2:
		if IsLeapYear(year) {
			return 29
		}
		return 28
	}
	return 0
}

type tokenKind int

const (
	tokLiteral tokenKind = iota
	tokYear
	tokMonth
	tokDay
	tokHour
	tokMinute
	tokSecond
	tokOffset
)

type token struct {
	kind tokenKind
	lit  byte
}

var tokenTable = []struct {
	text string
	kind tokenKind
}{
	{"YYYY", tokYear},
	{"MM", tokMonth},
	{"DD", tokDay},
	{"HH", tokHour},
	{"mm", tokMinute},
	{"ss", tokSecond},
	{"Z", tokOffset},
}

func compileFormat(format string) ([]token, error) {
	var toks []token
	for i := 0; i < len(format); {
		matched := false
		for _, tt := range tokenTable {
			if strings.HasPrefix(format[i:], tt.text) {
				toks = append(toks, token{kind: tt.kind})
				i += len(tt.text)
				matched = true
				break
			}
		}
		if !matched {
			toks = append(toks, token{kind: tokLiteral, lit: format[i]})
			i++
		}
	}
	if len(toks) == 0 {
		return nil, fmt.Errorf("dateparse: empty format")
	}
	return toks, nil
}

func isDigit(b byte) bool { return b >= '0' && b <= '9' }

func readNDigits(s string, pos, n int) (int, bool) {
	if pos+n > len(s) {
		return 0, false
	}
	v := 0
	for i := 0; i < n; i++ {
		if !isDigit(s[pos+i]) {
			return 0, false
		}
		v = v*10 + int(s[pos+i]-'0')
	}
	return v, true
}

// matchAt tries to match the compiled format against s starting at pos.
// It returns the parsed date and the end offset, or ok=false on mismatch.
// A leap second yields ErrLeapSecond.
func matchAt(toks []token, s string, pos int) (Date, int, error) {
	var d Date
	i := pos
	for _, t := range toks {
		switch t.kind {
		case tokLiteral:
			if i >= len(s) || s[i] != t.lit {
				return Date{}, 0, errMismatch
			}
			i++
		case tokYear:
			v, ok := readNDigits(s, i, 4)
			if !ok {
				return Date{}, 0, errMismatch
			}
			d.Year = v
			i += 4
		case tokMonth:
			v, ok := readNDigits(s, i, 2)
			if !ok {
				return Date{}, 0, errMismatch
			}
			d.Month = v
			i += 2
		case tokDay:
			v, ok := readNDigits(s, i, 2)
			if !ok {
				return Date{}, 0, errMismatch
			}
			d.Day = v
			i += 2
		case tokHour:
			v, ok := readNDigits(s, i, 2)
			if !ok {
				return Date{}, 0, errMismatch
			}
			d.Hour = v
			d.HasTime = true
			i += 2
		case tokMinute:
			v, ok := readNDigits(s, i, 2)
			if !ok {
				return Date{}, 0, errMismatch
			}
			d.Minute = v
			d.HasTime = true
			i += 2
		case tokSecond:
			v, ok := readNDigits(s, i, 2)
			if !ok {
				return Date{}, 0, errMismatch
			}
			if v == 60 {
				return Date{}, 0, ErrLeapSecond
			}
			d.Second = v
			d.HasTime = true
			i += 2
		case tokOffset:
			if i+6 > len(s) || (s[i] != '+' && s[i] != '-') || s[i+3] != ':' {
				return Date{}, 0, errMismatch
			}
			h, ok1 := readNDigits(s, i+1, 2)
			m, ok2 := readNDigits(s, i+4, 2)
			if !ok1 || !ok2 {
				return Date{}, 0, errMismatch
			}
			off := h*60 + m
			if s[i] == '-' {
				off = -off
			}
			d.OffsetMinutes = off
			d.HasOffset = true
			i += 6
		}
	}
	if err := validate(&d); err != nil {
		return Date{}, 0, err
	}
	return d, i, nil
}

var errMismatch = errors.New("dateparse: format mismatch")

// validate applies the explicit Gregorian calendar rules.
func validate(d *Date) error {
	if d.Month < 1 || d.Month > 12 {
		return fmt.Errorf("dateparse: month %d out of range 1-12", d.Month)
	}
	if d.Day < 1 || d.Day > DaysInMonth(d.Year, d.Month) {
		return fmt.Errorf("dateparse: day %d out of range for %04d-%02d", d.Day, d.Year, d.Month)
	}
	if d.Hour > 23 {
		return fmt.Errorf("dateparse: hour %d out of range 0-23", d.Hour)
	}
	if d.Minute > 59 {
		return fmt.Errorf("dateparse: minute %d out of range 0-59", d.Minute)
	}
	if d.Second > 59 {
		return fmt.Errorf("dateparse: second %d out of range 0-59", d.Second)
	}
	if d.HasOffset {
		if d.OffsetMinutes > 23*60+59 || d.OffsetMinutes < -(23*60+59) {
			return fmt.Errorf("dateparse: offset %d minutes out of range", d.OffsetMinutes)
		}
	}
	return nil
}

// Parse scans input for the leftmost position where at least one of the
// formats matches, and returns the parsed date, the matching formats and
// the matched interval within input.
//
// If several formats match at that position but disagree on the date, an
// *AmbiguityError is returned. If a match contains a leap second,
// ErrLeapSecond is returned. If nothing matches, ErrNoMatch is returned.
func Parse(input string, formats []string) (Result, error) {
	if len(formats) == 0 {
		return Result{}, fmt.Errorf("dateparse: no formats provided")
	}
	compiled := make([][]token, len(formats))
	for i, f := range formats {
		toks, err := compileFormat(f)
		if err != nil {
			return Result{}, err
		}
		compiled[i] = toks
	}

	var leapErr error
	for start := 0; start < len(input); start++ {
		var matches []Candidate
		end := -1
		for i, toks := range compiled {
			d, e, err := matchAt(toks, input, start)
			if err == ErrLeapSecond {
				leapErr = ErrLeapSecond
				continue
			}
			if err != nil {
				continue
			}
			if end == -1 {
				end = e
			} else if e != end {
				// Same start but different lengths: keep the longest match.
				if e > end {
					matches = matches[:0]
					end = e
				} else {
					continue
				}
			}
			matches = append(matches, Candidate{Format: formats[i], Date: d})
		}
		if len(matches) == 0 {
			continue
		}
		first := matches[0].Date
		agree := true
		for _, m := range matches[1:] {
			if m.Date != first {
				agree = false
				break
			}
		}
		if !agree {
			return Result{}, &AmbiguityError{Input: input, Start: start, End: end, Candidates: matches}
		}
		fmts := make([]string, len(matches))
		for i, m := range matches {
			fmts[i] = m.Format
		}
		return Result{Date: first, MatchedFormats: fmts, Start: start, End: end}, nil
	}
	if leapErr != nil {
		return Result{}, leapErr
	}
	return Result{}, ErrNoMatch
}
