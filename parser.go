package dataeng

import (
	"math/big"
	"strings"
	"unicode/utf8"
)

// Expr is a parsed unit expression: a dimension vector plus an exact
// rational scale to the SI base units. A single affine temperature unit
// (degC, degF) is also a valid Expr, but affine units can never appear
// inside products, quotients, or powers.
type Expr struct {
	Dims   Dimension
	Scale  *big.Rat
	affine *Unit
	text   string
}

// Affine reports whether the expression is exactly one affine unit.
func (e *Expr) Affine() bool { return e.affine != nil }

// String returns the original expression text.
func (e *Expr) String() string { return e.text }

// Parse parses a unit expression such as "kg*m/s^2", "mL", "km/h" or "°C"
// into its dimension vector and rational scale. Unknown symbols are
// reported with their byte offset in the input.
func Parse(input string) (*Expr, error) {
	p := &parser{input: input}
	v, err := p.parseExpr()
	if err != nil {
		return nil, err
	}
	p.skipSpaces()
	if p.pos != len(p.input) {
		return nil, errAt(p.pos, p.pos+1, "unexpected character %q", rune(p.input[p.pos]))
	}
	return &Expr{Dims: v.dims, Scale: v.scale, affine: v.affine, text: input}, nil
}

// MustParse is like Parse but panics on error; intended for tests and
// package-level variables.
func MustParse(input string) *Expr {
	e, err := Parse(input)
	if err != nil {
		panic(err)
	}
	return e
}

type pvalue struct {
	dims      Dimension
	scale     *big.Rat
	affine    *Unit
	affinePos int
}

type parser struct {
	input string
	pos   int
}

func (p *parser) skipSpaces() {
	for p.pos < len(p.input) && (p.input[p.pos] == ' ' || p.input[p.pos] == '\t') {
		p.pos++
	}
}

func isDelim(c byte) bool {
	switch c {
	case ' ', '\t', '(', ')', '*', '/', '^':
		return true
	}
	return c >= '0' && c <= '9'
}

func (p *parser) parseExpr() (pvalue, error) {
	left, err := p.parseTerm()
	if err != nil {
		return pvalue{}, err
	}
	for {
		p.skipSpaces()
		if p.pos >= len(p.input) {
			return left, nil
		}
		c := p.input[p.pos]
		var mul bool
		switch {
		case c == '*':
			mul = true
			p.pos++
		case c == '/':
			mul = false
			p.pos++
		case c == 0xC2 && p.pos+1 < len(p.input) && p.input[p.pos+1] == 0xB7: // '·'
			mul = true
			p.pos += 2
		default:
			return left, nil
		}
		right, err := p.parseTerm()
		if err != nil {
			return pvalue{}, err
		}
		if left.affine != nil {
			return pvalue{}, errAt(left.affinePos, left.affinePos+len(left.affine.Symbol),
				"affine unit %q cannot be combined with other units", left.affine.Symbol)
		}
		if right.affine != nil {
			return pvalue{}, errAt(right.affinePos, right.affinePos+len(right.affine.Symbol),
				"affine unit %q cannot be combined with other units", right.affine.Symbol)
		}
		if mul {
			left.dims = left.dims.Add(right.dims)
			left.scale = new(big.Rat).Mul(left.scale, right.scale)
		} else {
			if right.scale.Sign() == 0 {
				return pvalue{}, errAt(p.pos, p.pos, "division by zero scale")
			}
			left.dims = left.dims.Sub(right.dims)
			left.scale = new(big.Rat).Quo(left.scale, right.scale)
		}
	}
}

func (p *parser) parseTerm() (pvalue, error) {
	v, err := p.parseFactor()
	if err != nil {
		return pvalue{}, err
	}
	n, ok, err := p.parseExponent()
	if err != nil {
		return pvalue{}, err
	}
	if !ok || n == 1 {
		return v, nil
	}
	if v.affine != nil {
		return pvalue{}, errAt(v.affinePos, v.affinePos+len(v.affine.Symbol),
			"affine unit %q cannot be raised to a power", v.affine.Symbol)
	}
	return pvalue{dims: v.dims.Pow(n), scale: ratPow(v.scale, n)}, nil
}

func (p *parser) parseFactor() (pvalue, error) {
	p.skipSpaces()
	if p.pos >= len(p.input) {
		return pvalue{}, errAt(p.pos, p.pos, "unexpected end of expression")
	}
	c := p.input[p.pos]
	switch {
	case c == '(':
		p.pos++
		v, err := p.parseExpr()
		if err != nil {
			return pvalue{}, err
		}
		p.skipSpaces()
		if p.pos >= len(p.input) || p.input[p.pos] != ')' {
			return pvalue{}, errAt(p.pos, p.pos, "missing closing parenthesis")
		}
		p.pos++
		return v, nil
	case c >= '0' && c <= '9':
		start := p.pos
		for p.pos < len(p.input) && p.input[p.pos] >= '0' && p.input[p.pos] <= '9' {
			p.pos++
		}
		n, ok := new(big.Rat).SetString(p.input[start:p.pos])
		if !ok || n.Sign() <= 0 {
			return pvalue{}, errAt(start, p.pos, "invalid numeric factor %q", p.input[start:p.pos])
		}
		return pvalue{dims: dimless, scale: n}, nil
	default:
		return p.matchUnit()
	}
}

// matchUnit consumes the longest registered symbol or prefix+symbol
// combination at the current position.
func (p *parser) matchUnit() (pvalue, error) {
	rest := p.input[p.pos:]
	bestLen := 0
	var best *Unit
	var bestScale *big.Rat
	for sym, u := range unitsBySymbol {
		if len(sym) > bestLen && strings.HasPrefix(rest, sym) {
			bestLen, best, bestScale = len(sym), u, u.Scale
		}
	}
	for _, pf := range prefixes {
		for sym, u := range unitsBySymbol {
			if !u.Prefixable {
				continue
			}
			cand := pf.Symbol + sym
			if len(cand) > bestLen && strings.HasPrefix(rest, cand) {
				bestLen, best = len(cand), u
				bestScale = new(big.Rat).Mul(pf.Factor, u.Scale)
			}
		}
	}
	if bestLen == 0 {
		end := p.pos
		for end < len(p.input) && !isDelim(p.input[end]) {
			end++
		}
		if end == p.pos {
			end++
		}
		return pvalue{}, errAt(p.pos, end, "unknown unit %q", p.input[p.pos:end])
	}
	v := pvalue{dims: best.Dims, scale: bestScale}
	if best.Affine() {
		v.affine = best
		v.affinePos = p.pos
	}
	p.pos += bestLen
	return v, nil
}

var superscriptDigits = map[rune]int{
	'⁰': 0, '¹': 1, '²': 2, '³': 3, '⁴': 4,
	'⁵': 5, '⁶': 6, '⁷': 7, '⁸': 8, '⁹': 9,
}

// parseExponent reads an optional exponent: "^n", "**n", a run of Unicode
// superscripts, or digits directly attached to the preceding factor.
func (p *parser) parseExponent() (int, bool, error) {
	save := p.pos
	p.skipSpaces()
	if p.pos < len(p.input) && p.input[p.pos] == '^' {
		p.pos++
		return p.parseSignedInt()
	}
	if p.pos+1 < len(p.input) && p.input[p.pos] == '*' && p.input[p.pos+1] == '*' {
		p.pos += 2
		return p.parseSignedInt()
	}
	p.pos = save
	if p.pos < len(p.input) {
		r, _ := utf8.DecodeRuneInString(p.input[p.pos:])
		if r == '⁻' {
			_, size := utf8.DecodeRuneInString(p.input[p.pos:])
			p.pos += size
			n, ok, err := p.parseSuperscripts()
			if err != nil || !ok {
				return 0, false, errAt(p.pos, p.pos, "expected superscript exponent")
			}
			return -n, true, nil
		}
		if _, ok := superscriptDigits[r]; ok {
			return p.parseSuperscripts()
		}
	}
	if p.pos < len(p.input) && p.input[p.pos] >= '0' && p.input[p.pos] <= '9' {
		n := 0
		for p.pos < len(p.input) && p.input[p.pos] >= '0' && p.input[p.pos] <= '9' {
			n = n*10 + int(p.input[p.pos]-'0')
			if n > 64 {
				return 0, false, errAt(p.pos, p.pos+1, "exponent too large")
			}
			p.pos++
		}
		return n, true, nil
	}
	return 0, false, nil
}

func (p *parser) parseSuperscripts() (int, bool, error) {
	n := 0
	count := 0
	for p.pos < len(p.input) {
		r, size := utf8.DecodeRuneInString(p.input[p.pos:])
		d, ok := superscriptDigits[r]
		if !ok {
			break
		}
		n = n*10 + d
		if n > 64 {
			return 0, false, errAt(p.pos, p.pos+size, "exponent too large")
		}
		count++
		p.pos += size
	}
	return n, count > 0, nil
}

func (p *parser) parseSignedInt() (int, bool, error) {
	p.skipSpaces()
	neg := false
	if p.pos < len(p.input) && (p.input[p.pos] == '-' || p.input[p.pos] == '+') {
		neg = p.input[p.pos] == '-'
		p.pos++
	}
	start := p.pos
	n := 0
	for p.pos < len(p.input) && p.input[p.pos] >= '0' && p.input[p.pos] <= '9' {
		n = n*10 + int(p.input[p.pos]-'0')
		if n > 64 {
			return 0, false, errAt(start, p.pos+1, "exponent too large")
		}
		p.pos++
	}
	if p.pos == start {
		return 0, false, errAt(start, start+1, "expected integer exponent")
	}
	if neg {
		n = -n
	}
	return n, true, nil
}

func ratPow(r *big.Rat, n int) *big.Rat {
	if n == 0 {
		return ratInt(1)
	}
	if n < 0 {
		r = new(big.Rat).Inv(r)
		n = -n
	}
	exp := big.NewInt(int64(n))
	num := new(big.Int).Exp(r.Num(), exp, nil)
	den := new(big.Int).Exp(r.Denom(), exp, nil)
	return new(big.Rat).SetFrac(num, den)
}
