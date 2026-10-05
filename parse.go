package main

import (
	"bufio"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// MaxRules is the maximum number of rules the CLI accepts.
const MaxRules = 18

// Input is the parsed CLI input: the rules and the request value.
type Input struct {
	Rules []Rule
	Value int
}

// ParseInput reads the input format from r:
//
//	N
//	id layer action lo hi   (N lines, action is allow|deny)
//	v
//
// All fields are whitespace separated. IDs must be unique, intervals
// must satisfy lo <= hi, and N must be at most MaxRules.
func ParseInput(r io.Reader) (Input, error) {
	sc := bufio.NewScanner(r)
	sc.Split(bufio.ScanWords)
	next := func() (string, error) {
		if !sc.Scan() {
			if err := sc.Err(); err != nil {
				return "", err
			}
			return "", io.ErrUnexpectedEOF
		}
		return sc.Text(), nil
	}
	atoi := func(what string) (int, error) {
		tok, err := next()
		if err != nil {
			return 0, fmt.Errorf("reading %s: %w", what, err)
		}
		n, err := strconv.Atoi(tok)
		if err != nil {
			return 0, fmt.Errorf("reading %s: %q is not an integer", what, tok)
		}
		return n, nil
	}

	n, err := atoi("rule count")
	if err != nil {
		return Input{}, err
	}
	if n < 0 || n > MaxRules {
		return Input{}, fmt.Errorf("rule count %d out of range [0, %d]", n, MaxRules)
	}

	in := Input{Rules: make([]Rule, 0, n)}
	seen := map[string]bool{}
	for i := 0; i < n; i++ {
		id, err := next()
		if err != nil {
			return Input{}, fmt.Errorf("rule %d: reading id: %w", i+1, err)
		}
		if strings.TrimSpace(id) == "" {
			return Input{}, fmt.Errorf("rule %d: empty id", i+1)
		}
		if seen[id] {
			return Input{}, fmt.Errorf("rule %d: duplicate id %q", i+1, id)
		}
		seen[id] = true
		layer, err := atoi(fmt.Sprintf("rule %d layer", i+1))
		if err != nil {
			return Input{}, err
		}
		tok, err := next()
		if err != nil {
			return Input{}, fmt.Errorf("rule %d: reading action: %w", i+1, err)
		}
		act, err := parseAction(tok)
		if err != nil {
			return Input{}, fmt.Errorf("rule %d: %w", i+1, err)
		}
		lo, err := atoi(fmt.Sprintf("rule %d lo", i+1))
		if err != nil {
			return Input{}, err
		}
		hi, err := atoi(fmt.Sprintf("rule %d hi", i+1))
		if err != nil {
			return Input{}, err
		}
		if lo > hi {
			return Input{}, fmt.Errorf("rule %d: empty interval [%d, %d]", i+1, lo, hi)
		}
		in.Rules = append(in.Rules, Rule{ID: id, Layer: layer, Act: act, Lo: lo, Hi: hi})
	}

	v, err := atoi("request value")
	if err != nil {
		return Input{}, err
	}
	in.Value = v
	return in, nil
}
