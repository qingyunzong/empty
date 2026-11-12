package dataeng

import (
	"fmt"
	"math/big"
	"strings"
)

func parseFiniteDecimal(s string) (*big.Rat, error) {
	if s == "" {
		return nil, fmt.Errorf("%w: empty numeric value", ErrInvalidHeader)
	}

	negative := false
	switch s[0] {
	case '+':
		s = s[1:]
	case '-':
		negative = true
		s = s[1:]
	}
	if s == "" {
		return nil, fmt.Errorf("%w: invalid numeric value", ErrInvalidHeader)
	}

	dot := strings.IndexByte(s, '.')
	if dot >= 0 && strings.IndexByte(s[dot+1:], '.') >= 0 {
		return nil, fmt.Errorf("%w: invalid decimal value", ErrInvalidHeader)
	}

	integerPart := s
	fractionPart := ""
	if dot >= 0 {
		integerPart = s[:dot]
		fractionPart = s[dot+1:]
	}
	if integerPart == "" && fractionPart == "" {
		return nil, fmt.Errorf("%w: invalid decimal value", ErrInvalidHeader)
	}
	if !allDecimalDigits(integerPart) || !allDecimalDigits(fractionPart) {
		return nil, fmt.Errorf("%w: invalid decimal value", ErrInvalidHeader)
	}

	digits := integerPart + fractionPart
	numerator, ok := new(big.Int).SetString(digits, 10)
	if !ok {
		return nil, fmt.Errorf("%w: invalid decimal value", ErrInvalidHeader)
	}
	if negative {
		numerator.Neg(numerator)
	}

	denominator := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(len(fractionPart))), nil)
	return new(big.Rat).SetFrac(numerator, denominator), nil
}

func parseDecimalInteger(s string) (*big.Int, error) {
	if s == "" {
		return nil, fmt.Errorf("%w: empty integer value", ErrInvalidHeader)
	}

	negative := false
	switch s[0] {
	case '+':
		s = s[1:]
	case '-':
		negative = true
		s = s[1:]
	}
	if s == "" || !allDecimalDigits(s) {
		return nil, fmt.Errorf("%w: invalid integer value %q", ErrInvalidHeader, s)
	}

	n, ok := new(big.Int).SetString(s, 10)
	if !ok {
		return nil, fmt.Errorf("%w: invalid integer value", ErrInvalidHeader)
	}
	if negative {
		n.Neg(n)
	}
	return n, nil
}

func parseDecimalInt64(s string) (int64, error) {
	n, err := parseDecimalInteger(s)
	if err != nil {
		return 0, err
	}
	if !n.IsInt64() {
		return 0, fmt.Errorf("%w: integer is outside int64 range", ErrInvalidHeader)
	}
	return n.Int64(), nil
}

func allDecimalDigits(s string) bool {
	if s == "" {
		return true
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func parseAllowedValue(s string) error {
	if s == "T" || s == "F" {
		return nil
	}
	_, err := parseFiniteDecimal(s)
	return err
}
