// Package macro implements a small hygienic macro library with
// parameters, local definitions, lexical scoping, caller-env argument
// evaluation, expansion call chains and a step budget.
package macro

import (
	"fmt"
	"strconv"
	"strings"
)

// Value is any syntax-tree node or runtime value.
type Value = any

type Symbol string
type Int int64
type Bool bool
type List []Value

// Parse reads all top-level forms from src.
func Parse(src string) ([]Value, error) {
	toks, err := tokenize(src)
	if err != nil {
		return nil, err
	}
	var forms []Value
	pos := 0
	for pos < len(toks) {
		f, err := parseForm(toks, &pos)
		if err != nil {
			return nil, err
		}
		forms = append(forms, f)
	}
	return forms, nil
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
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c == '(' || c == ')' || c == '\'':
			toks = append(toks, string(c))
			i++
		default:
			j := i
			for j < len(src) && !strings.ContainsRune("()'; \t\n\r", rune(src[j])) {
				j++
			}
			toks = append(toks, src[i:j])
			i = j
		}
	}
	return toks, nil
}

func parseForm(toks []string, pos *int) (Value, error) {
	if *pos >= len(toks) {
		return nil, fmt.Errorf("parse: unexpected end of input")
	}
	tok := toks[*pos]
	*pos++
	switch tok {
	case "(":
		var out List
		for {
			if *pos >= len(toks) {
				return nil, fmt.Errorf("parse: unclosed list")
			}
			if toks[*pos] == ")" {
				*pos++
				return out, nil
			}
			f, err := parseForm(toks, pos)
			if err != nil {
				return nil, err
			}
			out = append(out, f)
		}
	case ")":
		return nil, fmt.Errorf("parse: unexpected )")
	case "'":
		f, err := parseForm(toks, pos)
		if err != nil {
			return nil, err
		}
		return List{Symbol("quote"), f}, nil
	default:
		if n, err := strconv.ParseInt(tok, 10, 64); err == nil {
			return Int(n), nil
		}
		switch tok {
		case "#t":
			return Bool(true), nil
		case "#f":
			return Bool(false), nil
		}
		return Symbol(tok), nil
	}
}
