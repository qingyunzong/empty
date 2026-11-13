package dataeng

import (
	"math"
	"strconv"
	"strings"
)

// isInteger reports whether text is a decimal, hex (0x), octal (0o) or
// binary (0b) integer literal, allowing underscores between digits.
func isInteger(text string) bool {
	if text == "" {
		return false
	}
	body := text
	if body[0] == '+' || body[0] == '-' {
		body = body[1:]
	}
	if body == "" {
		return false
	}

	var base int
	switch {
	case strings.HasPrefix(body, "0x") || strings.HasPrefix(body, "0X"):
		base = 16
	case strings.HasPrefix(body, "0o") || strings.HasPrefix(body, "0O"):
		base = 8
	case strings.HasPrefix(body, "0b") || strings.HasPrefix(body, "0B"):
		base = 2
	default:
		base = 10
	}
	if base != 10 {
		body = body[2:]
	}
	if body == "" || !validDigits(body, base) {
		return false
	}
	return true
}

func validDigits(body string, base int) bool {
	for i := 0; i < len(body); i++ {
		b := body[i]
		if b == '_' {
			if i == 0 || i == len(body)-1 || body[i-1] == '_' {
				return false
			}
			continue
		}
		if !digitInBase(b, base) {
			return false
		}
	}
	return true
}

func digitInBase(b byte, base int) bool {
	switch {
	case b >= '0' && b <= '9':
		return int(b-'0') < base
	case base == 16 && b >= 'a' && b <= 'f':
		return true
	case base == 16 && b >= 'A' && b <= 'F':
		return true
	default:
		return false
	}
}

func parseInteger(text string) (int64, error) {
	negative := false
	body := text
	if body[0] == '+' || body[0] == '-' {
		negative = body[0] == '-'
		body = body[1:]
	}

	base := 10
	switch {
	case strings.HasPrefix(body, "0x"), strings.HasPrefix(body, "0X"):
		base = 16
	case strings.HasPrefix(body, "0o"), strings.HasPrefix(body, "0O"):
		base = 8
	case strings.HasPrefix(body, "0b"), strings.HasPrefix(body, "0B"):
		base = 2
	}
	if base != 10 {
		body = body[2:]
	}
	cleaned := strings.ReplaceAll(body, "_", "")

	if base == 10 && len(cleaned) > 1 && cleaned[0] == '0' {
		return 0, &ParseError{Msg: "leading zero is not allowed in decimal integer"}
	}
	value, err := strconv.ParseUint(cleaned, base, 64)
	if err != nil {
		return 0, &ParseError{Msg: "integer out of range or malformed: " + text}
	}
	if negative {
		if value > uint64(math.MaxInt64)+1 {
			return 0, &ParseError{Msg: "integer out of range: " + text}
		}
		return -int64(value), nil
	}
	if value > math.MaxInt64 {
		return 0, &ParseError{Msg: "integer out of range: " + text}
	}
	return int64(value), nil
}

// isFloat reports whether text is a float literal: a decimal point form,
// an exponent form, or an underscore-separated variant of either.
func isFloat(text string) bool {
	body := text
	if body != "" && (body[0] == '+' || body[0] == '-') {
		body = body[1:]
	}
	if body == "" {
		return false
	}

	hasDot := strings.Contains(body, ".")
	hasExp := strings.ContainsAny(body, "eE")
	if !hasDot && !hasExp {
		return false
	}

	mantissa := body
	if hasExp {
		idx := strings.IndexAny(body, "eE")
		mantissa = body[:idx]
		exponent := body[idx+1:]
		if exponent == "" {
			return false
		}
		if exponent[0] == '+' || exponent[0] == '-' {
			exponent = exponent[1:]
		}
		if !validDigits(exponent, 10) {
			return false
		}
	}

	if mantissa == "" || !validFloatMantissa(mantissa, hasDot) {
		return false
	}
	return true
}

func validFloatMantissa(mantissa string, hasDot bool) bool {
	if hasDot {
		parts := strings.Split(mantissa, ".")
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			return false
		}
		for _, part := range parts {
			if !validDigits(part, 10) {
				return false
			}
		}
		return true
	}
	return validDigits(mantissa, 10)
}

func parseFloat(text string) (float64, error) {
	cleaned := strings.ReplaceAll(text, "_", "")
	value, err := strconv.ParseFloat(cleaned, 64)
	if err != nil {
		return 0, &ParseError{Msg: "malformed float: " + text}
	}
	return value, nil
}
