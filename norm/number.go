package norm

import (
	"fmt"
	"math/big"
	"strings"
)

// canonicalNumber validates a JSON number literal and returns a canonical
// decimal representation that preserves the exact decimal value of the
// literal. The result is always a valid strict-JSON number.
//
// Canonical form: the mantissa carries no leading or trailing zeros; plain
// notation is used when the decimal point position is within [-10, 50],
// otherwise scientific notation ("d[.ddd]e±X") is used. Zero canonicalizes
// to "0".
func canonicalNumber(lit string) (string, error) {
	err := fmt.Errorf("invalid number %q", lit)
	pos := 0
	neg := false
	if pos < len(lit) && lit[pos] == '-' {
		neg = true
		pos++
	}
	// Integer part: 0 | [1-9][0-9]*
	if pos >= len(lit) || !isDigit(lit[pos]) {
		return "", err
	}
	var intPart string
	if lit[pos] == '0' {
		intPart = "0"
		pos++
		if pos < len(lit) && isDigit(lit[pos]) {
			return "", err // leading zero
		}
	} else {
		start := pos
		for pos < len(lit) && isDigit(lit[pos]) {
			pos++
		}
		intPart = lit[start:pos]
	}
	// Fraction part.
	var fracPart string
	if pos < len(lit) && lit[pos] == '.' {
		pos++
		start := pos
		for pos < len(lit) && isDigit(lit[pos]) {
			pos++
		}
		if pos == start {
			return "", err
		}
		fracPart = lit[start:pos]
	}
	// Exponent part.
	exp := new(big.Int)
	if pos < len(lit) && (lit[pos] == 'e' || lit[pos] == 'E') {
		pos++
		esign := ""
		if pos < len(lit) && (lit[pos] == '+' || lit[pos] == '-') {
			if lit[pos] == '-' {
				esign = "-"
			}
			pos++
		}
		start := pos
		for pos < len(lit) && isDigit(lit[pos]) {
			pos++
		}
		if pos == start {
			return "", err
		}
		if _, ok := exp.SetString(esign+lit[start:pos], 10); !ok {
			return "", err
		}
	}
	if pos != len(lit) {
		return "", err
	}

	// value = digits * 10^exp
	digits := intPart + fracPart
	exp.Sub(exp, big.NewInt(int64(len(fracPart))))
	digits = strings.TrimLeft(digits, "0")
	if digits == "" {
		return "0", nil
	}
	trailing := 0
	for digits[len(digits)-1-trailing] == '0' {
		trailing++
	}
	if trailing > 0 {
		digits = digits[:len(digits)-trailing]
		exp.Add(exp, big.NewInt(int64(trailing)))
	}

	// pointExp is the position of the decimal point relative to the first
	// significant digit: value = 0.digits * 10^pointExp.
	pointExp := new(big.Int).Add(exp, big.NewInt(int64(len(digits))))
	var out string
	if pointExp.IsInt64() {
		if pe := pointExp.Int64(); pe >= -10 && pe <= 50 {
			out = plainNotation(digits, pe)
		}
	}
	if out == "" {
		e := new(big.Int).Sub(pointExp, big.NewInt(1))
		mant := digits[:1]
		if len(digits) > 1 {
			mant += "." + digits[1:]
		}
		if e.Sign() < 0 {
			out = mant + "e-" + new(big.Int).Abs(e).String()
		} else {
			out = mant + "e+" + e.String()
		}
	}
	if neg {
		out = "-" + out
	}
	return out, nil
}

func plainNotation(digits string, pointExp int64) string {
	switch {
	case pointExp <= 0:
		return "0." + strings.Repeat("0", int(-pointExp)) + digits
	case pointExp >= int64(len(digits)):
		return digits + strings.Repeat("0", int(pointExp)-len(digits))
	default:
		return digits[:pointExp] + "." + digits[pointExp:]
	}
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }
