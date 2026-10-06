package dateparse

import (
	"fmt"
	"strings"
)

// FormatError reports a layout that violates the package's format contract,
// for example one that omits the year, month or day.
type FormatError struct {
	Format string
	Reason string
}

func (e *FormatError) Error() string {
	if e.Format == "" {
		return "dateparse: " + e.Reason
	}
	return fmt.Sprintf("dateparse: invalid format %q: %s", e.Format, e.Reason)
}

// NoMatchError reports that none of the supplied formats matched the input.
type NoMatchError struct {
	Input   string
	Formats []string
}

func (e *NoMatchError) Error() string {
	return fmt.Sprintf("dateparse: no format matched input %q (tried %s)",
		e.Input, strings.Join(quoted(e.Formats), ", "))
}

// AmbiguityError reports that several formats matched the input but produced
// different dates. The library never guesses which one is right.
type AmbiguityError struct {
	Input      string
	Candidates []Candidate
}

func (e *AmbiguityError) Error() string {
	parts := make([]string, 0, len(e.Candidates))
	for _, c := range e.Candidates {
		parts = append(parts, fmt.Sprintf("format %q -> %s at [%d:%d)",
			c.Format, c.Date, c.Start, c.End))
	}
	return fmt.Sprintf("dateparse: ambiguous input %q: %s",
		e.Input, strings.Join(parts, "; "))
}

// LeapSecondError reports an input whose seconds field is 60. Leap seconds
// are not supported and are always rejected.
type LeapSecondError struct {
	Format     string
	Start, End int
}

func (e *LeapSecondError) Error() string {
	return fmt.Sprintf("dateparse: leap second (:60) rejected at [%d:%d) for format %q",
		e.Start, e.End, e.Format)
}

func quoted(ss []string) []string {
	out := make([]string, len(ss))
	for i, s := range ss {
		out[i] = fmt.Sprintf("%q", s)
	}
	return out
}
