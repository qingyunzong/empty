package dataeng

import (
	"errors"
	"math/big"
)

// Number preserves a JSON number's original lexical form together with its
// exact rational value. Rat is constructed from the digits without expanding
// powers of ten into giant big.Int values beyond the configured exponent
// budget, so a hostile exponent cannot exhaust host memory.
type Number struct {
	lexeme string
	rat    *big.Rat
	neg    bool
	// digits holds all significant decimal digits in source order.
	digits []byte
	// decimalPos is the position of the decimal point measured in digits from
	// the left, before the exponent is applied.
	decimalPos int
	exp        int
}

// Lexeme returns the exact number text as it appeared in the input.
func (n *Number) Lexeme() string { return n.lexeme }

// Rat returns the exact rational value. The returned pointer must not be
// mutated by callers that need the tree's value to stay stable.
func (n *Number) Rat() *big.Rat { return n.rat }

// SignificantDigits returns the count of significant digits in the mantissa:
// leading zeros are excluded, all remaining digits (including trailing zeros)
// count.
func (n *Number) SignificantDigits() int {
	start := 0
	for start < len(n.digits) && n.digits[start] == '0' {
		start++
	}
	return len(n.digits) - start
}

// Exponent returns the effective decimal exponent after combining any explicit
// e/E exponent with the position of the decimal point.
func (n *Number) EffectiveExponent() int {
	return n.exp - (len(n.digits) - n.decimalPos)
}

// String returns the original lexeme.
func (n *Number) String() string { return n.lexeme }

// Budget limits the work the parser will spend on a single number.
//
// MaxSignificantDigits bounds the significant-digit count of the mantissa.
// MaxExponentExpansion bounds the absolute value of the effective decimal
// exponent, i.e. how far the decimal point may move; this keeps exact rational
// construction bounded. A zero value means unlimited, which callers should use
// deliberately.
type Budget struct {
	MaxSignificantDigits int
	MaxExponentExpansion int
}

// DefaultBudget is applied by NewParser unless overridden. It is intentionally
// generous for telemetry values while remaining bounded.
var DefaultBudget = Budget{
	MaxSignificantDigits: 1000,
	MaxExponentExpansion: 10000,
}

var (
	ErrSignificantDigitsExceeded = errors.New("dataeng: number significant-digit budget exceeded")
	ErrExponentBudgetExceeded    = errors.New("dataeng: number exponent expansion budget exceeded")
	ErrInvalidNumber             = errors.New("dataeng: invalid number lexeme")
)

// parseNumber validates lex against the JSON number grammar, enforces the
// budget, and builds an exact *big.Rat by integer scaling instead of relying
// on big.Rat.SetString, which may expand huge exponents eagerly.
func parseNumber(lex string, budget Budget) (*Number, error) {
	num := &Number{lexeme: lex, decimalPos: -1}
	i := 0
	if i < len(lex) && lex[i] == '-' {
		num.neg = true
		i++
	}

	intStart := i
	for i < len(lex) && isDigit(lex[i]) {
		num.digits = append(num.digits, lex[i])
		i++
	}
	intDigits := i - intStart
	if intDigits == 0 {
		return nil, ErrInvalidNumber
	}
	if intDigits > 1 && lex[intStart] == '0' {
		return nil, ErrInvalidNumber // leading zero is not allowed
	}
	num.decimalPos = len(num.digits)

	fracDigits := 0
	if i < len(lex) && lex[i] == '.' {
		i++
		fracStart := i
		for i < len(lex) && isDigit(lex[i]) {
			num.digits = append(num.digits, lex[i])
			i++
		}
		fracDigits = i - fracStart
		if fracDigits == 0 {
			return nil, ErrInvalidNumber
		}
	}

	hasExp := false
	if i < len(lex) && (lex[i] == 'e' || lex[i] == 'E') {
		hasExp = true
		i++
		expNeg := false
		if i < len(lex) && (lex[i] == '+' || lex[i] == '-') {
			expNeg = lex[i] == '-'
			i++
		}
		expStart := i
		var expVal int
		for i < len(lex) && isDigit(lex[i]) {
			if i-expStart >= maxExponentDigits {
				// An exponent this large cannot satisfy any bounded budget and
				// must never be expanded into a big.Int power of ten.
				return nil, ErrExponentBudgetExceeded
			}
			next := expVal*10 + int(lex[i]-'0')
			expVal = next
			i++
		}
		if i == expStart {
			return nil, ErrInvalidNumber
		}
		if expNeg {
			expVal = -expVal
		}
		num.exp = expVal
	}

	if i != len(lex) {
		return nil, ErrInvalidNumber
	}
	if !hasExp {
		num.exp = 0
	}
	if len(num.digits) == 0 {
		return nil, ErrInvalidNumber
	}

	if budget.MaxSignificantDigits > 0 && num.SignificantDigits() > budget.MaxSignificantDigits {
		return nil, ErrSignificantDigitsExceeded
	}

	effective := num.EffectiveExponent()
	if budget.MaxExponentExpansion > 0 {
		abs := effective
		if abs < 0 {
			abs = -abs
		}
		if abs > budget.MaxExponentExpansion {
			return nil, ErrExponentBudgetExceeded
		}
	}

	if err := num.buildRat(); err != nil {
		return nil, err
	}
	return num, nil
}

// buildRat computes numerator/denominator directly:
//
//	value = sign * mantissaDigits * 10^(exp - fracDigits)
//
// The exponent magnitude is already bounded by the caller.
func (n *Number) buildRat() error {
	mantissa := new(big.Int)
	if _, ok := mantissa.SetString(string(n.digits), 10); !ok {
		return ErrInvalidNumber
	}

	scale := n.exp - countFractional(n)
	ten := big.NewInt(10)

	num := new(big.Int).Set(mantissa)
	den := big.NewInt(1)
	if scale >= 0 {
		num.Mul(num, new(big.Int).Exp(ten, big.NewInt(int64(scale)), nil))
	} else {
		den.Exp(ten, big.NewInt(int64(-scale)), nil)
	}
	if n.neg {
		num.Neg(num)
	}
	n.rat = new(big.Rat).SetFrac(num, den)
	return nil
}

func countFractional(n *Number) int {
	return len(n.digits) - n.decimalPos
}

func isDigit(b byte) bool { return b >= '0' && b <= '9' }

// maxExponentDigits bounds explicit exponent length so an arbitrarily long
// run of exponent digits cannot overflow a native int. Any real-world decimal
// exponent is far shorter; budget checks then bound the effective magnitude.
const maxExponentDigits = 18
