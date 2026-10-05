// Package macro implements a small Lisp-like macro library with
// hygienic, lexically scoped macros. It uses only the Go standard library.
package macro

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"
)

// Expr is a parsed s-expression: Symbol, Int, Bool, or List.
type Expr any

type Symbol string
type Int int64
type Bool bool
type List []Expr

// Parse reads all top-level s-expressions from src.
func Parse(src string) ([]Expr, error) {
	toks, err := tokenize(src)
	if err != nil {
		return nil, err
	}
	var exprs []Expr
	i := 0
	for i < len(toks) {
		e, next, err := parseExpr(toks, i)
		if err != nil {
			return nil, err
		}
		exprs = append(exprs, e)
		i = next
	}
	return exprs, nil
}

func tokenize(src string) ([]string, error) {
	var toks []string
	i := 0
	for i < len(src) {
		c := src[i]
		switch {
		case c == ';':
			for i < len(src) && src[i] != '\n' {
				i++
			}
		case unicode.IsSpace(rune(c)):
			i++
		case c == '(' || c == ')' || c == '\'':
			toks = append(toks, string(c))
			i++
		default:
			j := i
			for j < len(src) && !unicode.IsSpace(rune(src[j])) && !strings.ContainsRune("()';", rune(src[j])) {
				j++
			}
			toks = append(toks, src[i:j])
			i = j
		}
	}
	return toks, nil
}

func parseExpr(toks []string, i int) (Expr, int, error) {
	if i >= len(toks) {
		return nil, i, fmt.Errorf("macro: unexpected end of input")
	}
	t := toks[i]
	switch t {
	case "(":
		var elems []Expr
		i++
		for {
			if i >= len(toks) {
				return nil, i, fmt.Errorf("macro: unclosed '('")
			}
			if toks[i] == ")" {
				return List(elems), i + 1, nil
			}
			e, next, err := parseExpr(toks, i)
			if err != nil {
				return nil, i, err
			}
			elems = append(elems, e)
			i = next
		}
	case ")":
		return nil, i, fmt.Errorf("macro: unexpected ')'")
	case "'":
		e, next, err := parseExpr(toks, i+1)
		if err != nil {
			return nil, i, err
		}
		return List{Symbol("quote"), e}, next, nil
	default:
		if n, err := strconv.ParseInt(t, 10, 64); err == nil {
			return Int(n), i + 1, nil
		}
		switch t {
		case "#t":
			return Bool(true), i + 1, nil
		case "#f":
			return Bool(false), i + 1, nil
		}
		return Symbol(t), i + 1, nil
	}
}

// String renders an expression (or value) as an s-expression.
func String(e Expr) string {
	var sb strings.Builder
	writeExpr(&sb, e)
	return sb.String()
}

func writeExpr(sb *strings.Builder, e Expr) {
	switch x := e.(type) {
	case Symbol:
		sb.WriteString(string(x))
	case Int:
		sb.WriteString(strconv.FormatInt(int64(x), 10))
	case Bool:
		if x {
			sb.WriteString("#t")
		} else {
			sb.WriteString("#f")
		}
	case List:
		sb.WriteByte('(')
		for i, el := range x {
			if i > 0 {
				sb.WriteByte(' ')
			}
			writeExpr(sb, el)
		}
		sb.WriteByte(')')
	default:
		fmt.Fprintf(sb, "%v", e)
	}
}
