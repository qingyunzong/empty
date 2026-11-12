package dataeng

import (
	"errors"
	"fmt"
)

// Verify checks a Result certificate from scratch. It recomputes the exact
// binary64 rounding interval, checks that the candidate lies in it, checks
// canonical text and metadata, and proves minimality by exact search for any
// shorter coefficient and for any better coefficient of equal length.
//
// Verify does not call floating-point parsing or formatting. In particular, a
// successful strconv.ParseFloat round trip would not by itself satisfy this
// function.
func Verify(r Result) error {
	bs := binary64Format
	expField := (r.Bits >> 52) & binary64ExpMask
	fracField := r.Bits & binary64FracMask

	if expField == binary64ExpMask {
		if fracField == 0 {
			if r.Class != ClassInf {
				return errors.New("verify: infinity has wrong class")
			}
			if r.C != nil || r.Q != 0 || r.Interval != nil {
				return errors.New("verify: infinity has decimal fields")
			}
			if r.NaNPayload != 0 {
				return errors.New("verify: infinity has NaN payload")
			}
			wantSign := 1
			if r.Bits&binary64SignBit != 0 {
				wantSign = -1
			}
			if r.Sign != wantSign {
				return errors.New("verify: infinity has wrong sign")
			}
			if r.Text != signedText(wantSign, "inf") {
				return errors.New("verify: infinity has non-canonical text")
			}
			if !r.RoundTrip {
				return errors.New("verify: infinity marked non-round-trip")
			}
			return nil
		}

		if r.Class != ClassNaN {
			return errors.New("verify: NaN has wrong class")
		}
		if r.C != nil || r.Q != 0 || r.Interval != nil {
			return errors.New("verify: NaN has decimal fields")
		}
		if r.Sign != 0 || r.Text != "nan" {
			return errors.New("verify: NaN sign or text is non-canonical")
		}
		if r.RoundTrip {
			return errors.New("verify: NaN cannot be marked round-trip")
		}
		if r.NaNPayload != fracField {
			return errors.New("verify: NaN payload metadata does not match original bits")
		}
		return nil
	}

	if r.Bits&^binary64SignBit == 0 {
		if r.Class != ClassZero {
			return errors.New("verify: zero has wrong class")
		}
		if r.C == nil || r.C.Sign() != 0 || r.Q != 0 || r.Interval != nil {
			return errors.New("verify: zero has wrong decimal fields")
		}
		wantSign := 1
		if r.Bits&binary64SignBit != 0 {
			wantSign = -1
		}
		if r.Sign != wantSign {
			return errors.New("verify: zero has wrong sign")
		}
		if r.Text != signedText(wantSign, "0e0") {
			return errors.New("verify: zero has non-canonical text")
		}
		if !r.RoundTrip || r.NaNPayload != 0 {
			return errors.New("verify: zero metadata is non-canonical")
		}
		return nil
	}

	if r.Class != ClassFinite {
		return errors.New("verify: non-zero finite value has wrong class")
	}
	if !r.RoundTrip || r.NaNPayload != 0 {
		return errors.New("verify: finite value metadata is non-canonical")
	}
	wantSign := 1
	if r.Bits&binary64SignBit != 0 {
		wantSign = -1
	}
	if r.Sign != wantSign {
		return errors.New("verify: finite value has wrong sign")
	}
	if r.C == nil || r.C.Sign() <= 0 {
		return errors.New("verify: finite value needs a positive coefficient")
	}
	if r.C.Cmp(pow10(17)) >= 0 {
		return errors.New("verify: coefficient exceeds 17 digits")
	}
	if isMultipleOfTen(r.C) {
		return errors.New("verify: coefficient is divisible by ten")
	}
	if r.Q < minDecimalExponent || r.Q > maxDecimalExponent {
		return errors.New("verify: exponent is outside [-400,400]")
	}
	digits := len(r.C.String())
	if r.Text != signedText(wantSign, decimalText(r.C, r.Q)) {
		return errors.New("verify: finite value has non-canonical text")
	}

	absBits := r.Bits &^ binary64SignBit
	v := bs.value(absBits)
	absIV := bs.absRoundingInterval(absBits)
	candidateValue := decimalValue(r.C, r.Q)
	if wantSign < 0 {
		candidateValue.Neg(candidateValue)
	}

	expectedInterval := publicInterval(absIV)
	if wantSign < 0 {
		expectedInterval = negateInterval(absIV)
	}
	if r.Interval == nil || r.Interval.Lower == nil || r.Interval.Upper == nil {
		return errors.New("verify: missing rounding interval")
	}
	if r.Interval.Lower.Cmp(expectedInterval.Lower) != 0 ||
		r.Interval.Upper.Cmp(expectedInterval.Upper) != 0 ||
		r.Interval.LowerClosed != expectedInterval.LowerClosed ||
		r.Interval.UpperClosed != expectedInterval.UpperClosed {
		return errors.New("verify: rounding interval does not match recomputed interval")
	}
	if !r.Interval.Contains(candidateValue) {
		return fmt.Errorf("verify: candidate %s*10^%d is outside the rounding interval", r.C, r.Q)
	}

	// Exact minimality proof. No shorter coefficient of any permitted exponent
	// may round to this value.
	for n := 1; n < digits; n++ {
		if _, ok := bestCandidateForDigits(v, absIV, n, binary64Search); ok {
			return fmt.Errorf("verify: found a %d-digit candidate shorter than %d digits", n, digits)
		}
	}

	// At the selected length, no candidate may be closer, or win the even
	// coefficient/smaller-value tie-breaks.
	best, ok := bestCandidateForDigits(v, absIV, digits, binary64Search)
	if !ok {
		return errors.New("verify: selected length unexpectedly has no valid candidate")
	}
	if best.c.Cmp(r.C) != 0 || best.q != r.Q {
		return errors.New("verify: a better candidate exists at the selected digit length")
	}

	return nil
}

// VerifyBits is a convenience wrapper that formats bits and verifies the
// resulting certificate.
func VerifyBits(bits uint64) error {
	return Verify(Format(bits))
}
