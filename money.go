package formal

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// Money is an exact signed amount in micro-units (one millionth of a currency
// unit). Integer arithmetic keeps per-entity allocations and conservation
// checks exact; no floating point value is ever used for money.
type Money int64

const (
	// MicrosPerUnit is the number of Money units in one currency unit.
	MicrosPerUnit int64 = 1_000_000
)

// ParseMoney parses a decimal amount with at most six fractional digits.
// It rejects values that cannot be represented exactly by Money.
func ParseMoney(s string) (Money, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, fmt.Errorf("formal: empty money amount")
	}

	negative := false
	switch s[0] {
	case '-':
		negative = true
		s = s[1:]
	case '+':
		s = s[1:]
	}
	if s == "" {
		return 0, fmt.Errorf("formal: invalid money amount")
	}

	wholeText, fractionText, hasPoint := strings.Cut(s, ".")
	if strings.Contains(fractionText, ".") {
		return 0, fmt.Errorf("formal: invalid money amount %q", s)
	}
	if wholeText == "" {
		wholeText = "0"
	}
	if !allDigits(wholeText) || !allDigits(fractionText) {
		return 0, fmt.Errorf("formal: invalid money amount %q", s)
	}
	if len(fractionText) > 6 {
		return 0, fmt.Errorf("formal: money amount has more than six fractional digits")
	}
	if hasPoint && fractionText == "" {
		return 0, fmt.Errorf("formal: money amount has no fractional digits")
	}

	whole, err := strconv.ParseInt(wholeText, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("formal: money amount out of range: %w", err)
	}
	if whole > math.MaxInt64/MicrosPerUnit {
		return 0, fmt.Errorf("formal: money amount out of range")
	}
	fraction := int64(0)
	if fractionText != "" {
		fraction, err = strconv.ParseInt(fractionText, 10, 64)
		if err != nil {
			return 0, fmt.Errorf("formal: invalid money fraction: %w", err)
		}
		for i := len(fractionText); i < 6; i++ {
			fraction *= 10
		}
	}

	if whole == math.MaxInt64/MicrosPerUnit && fraction > math.MaxInt64-whole*MicrosPerUnit {
		return 0, fmt.Errorf("formal: money amount out of range")
	}
	units := whole*MicrosPerUnit + fraction
	if negative {
		if units == 0 {
			return 0, nil
		}
		return Money(-units), nil
	}
	return Money(units), nil
}

// MustParseMoney is ParseMoney with panic on invalid input. It is intended for
// constants and tests.
func MustParseMoney(s string) Money {
	m, err := ParseMoney(s)
	if err != nil {
		panic(err)
	}
	return m
}

// FromCents converts an exact number of cents to Money.
func FromCents(cents int64) (Money, error) {
	if cents > math.MaxInt64/10_000 || cents < math.MinInt64/10_000 {
		return 0, fmt.Errorf("formal: cents amount out of range")
	}
	return Money(cents * 10_000), nil
}

// MustFromCents is FromCents with panic on overflow.
func MustFromCents(cents int64) Money {
	m, err := FromCents(cents)
	if err != nil {
		panic(err)
	}
	return m
}

// String renders the amount with at least two and at most six fractional
// digits, without thousands separators.
func (m Money) String() string {
	negative := m < 0
	var magnitude uint64
	if negative {
		magnitude = uint64(-(m + 1)) + 1
	} else {
		magnitude = uint64(m)
	}

	whole := magnitude / uint64(MicrosPerUnit)
	fraction := magnitude % uint64(MicrosPerUnit)
	fractionText := fmt.Sprintf("%06d", fraction)
	for len(fractionText) > 2 && fractionText[len(fractionText)-1] == '0' {
		fractionText = fractionText[:len(fractionText)-1]
	}

	prefix := ""
	if negative {
		prefix = "-"
	}
	return prefix + strconv.FormatUint(whole, 10) + "." + fractionText
}

// IsZero reports whether m is zero.
func (m Money) IsZero() bool { return m == 0 }

// Sign returns -1, 0, or 1 according to the sign of m.
func (m Money) Sign() int {
	switch {
	case m < 0:
		return -1
	case m > 0:
		return 1
	default:
		return 0
	}
}

func allDigits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func addMoney(a, b Money) (Money, error) {
	if b > 0 && a > Money(math.MaxInt64)-b {
		return 0, fmt.Errorf("formal: money overflow")
	}
	if b < 0 && a < Money(math.MinInt64)-b {
		return 0, fmt.Errorf("formal: money overflow")
	}
	return a + b, nil
}

func negateMoney(m Money) (Money, error) {
	if m == Money(math.MinInt64) {
		return 0, fmt.Errorf("formal: money overflow")
	}
	return -m, nil
}
