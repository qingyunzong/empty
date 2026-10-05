// Package lexer implements a streaming tokenizer driven by DFA tables.
//
// Rules are deterministic finite automata given as transition tables.
// When several rules match at the same start position, the longest match
// wins; ties are broken by rule declaration order (the earlier rule wins).
//
// The lexer is streaming: input arrives in chunks via Write. A token at the
// tail of the buffered input is never emitted early, because the next chunk
// might extend the match. A tail token is only finalized when every DFA has
// died (the match can no longer extend) or when End signals end of input.
package lexer

import (
	"errors"
	"fmt"
)

// ErrWriteAfterEnd is returned by Write after End has been called.
var ErrWriteAfterEnd = errors.New("lexer: write after End")

// Rule is a single lexical rule expressed as a DFA table.
//
// Trans[state][sym] is the next state for byte sym, or -1 for no transition.
// Accept marks accepting states. The empty string must not be accepted.
type Rule struct {
	Name   string
	Start  int
	Trans  [][]int
	Accept []bool
}

// Validate checks the table for structural consistency.
func (r Rule) Validate() error {
	if len(r.Trans) == 0 {
		return fmt.Errorf("lexer: rule %q has no states", r.Name)
	}
	if len(r.Accept) != len(r.Trans) {
		return fmt.Errorf("lexer: rule %q: Accept has %d entries, want %d", r.Name, len(r.Accept), len(r.Trans))
	}
	if r.Start < 0 || r.Start >= len(r.Trans) {
		return fmt.Errorf("lexer: rule %q: start state %d out of range", r.Name, r.Start)
	}
	if r.Accept[r.Start] {
		return fmt.Errorf("lexer: rule %q must not accept the empty string", r.Name)
	}
	for s, row := range r.Trans {
		if len(row) != 256 {
			return fmt.Errorf("lexer: rule %q: Trans[%d] has %d entries, want 256", r.Name, s, len(row))
		}
		for c, next := range row {
			if next < -1 || next >= len(r.Trans) {
				return fmt.Errorf("lexer: rule %q: Trans[%d][%d] = %d out of range", r.Name, s, c, next)
			}
		}
	}
	return nil
}

// Token is a lexed token. Start is the absolute byte offset in the stream.
type Token struct {
	Rule  int
	Name  string
	Text  string
	Start int
}

// Error reports input that no rule can match, at absolute offset Pos.
type Error struct {
	Pos int
}

func (e *Error) Error() string {
	return fmt.Sprintf("lexer: no rule matches input at offset %d", e.Pos)
}

// Lexer is a streaming tokenizer. It is not safe for concurrent use.
type Lexer struct {
	rules []Rule
	emit  func(Token)
	buf   []byte // unprocessed input
	base  int    // absolute offset of buf[0]
	ended bool
	err   error
}

// New builds a Lexer that delivers tokens to emit. Rules are tried in
// declaration order when breaking ties between equal-length matches.
// It panics if any rule table is invalid.
func New(emit func(Token), rules ...Rule) *Lexer {
	if emit == nil {
		panic("lexer: nil emit function")
	}
	if len(rules) == 0 {
		panic("lexer: no rules")
	}
	for _, r := range rules {
		if err := r.Validate(); err != nil {
			panic(err)
		}
	}
	return &Lexer{rules: rules, emit: emit}
}

// Write appends a chunk of input and emits every token that is decided.
// A trailing match whose DFA is still alive is held back, since a later
// chunk may extend it.
func (l *Lexer) Write(p []byte) error {
	if l.ended {
		return ErrWriteAfterEnd
	}
	if l.err != nil {
		return l.err
	}
	l.buf = append(l.buf, p...)
	return l.scan(false)
}

// End signals end of input and flushes the final token(s). Only now can a
// still-extendable tail match be finalized. End is idempotent.
func (l *Lexer) End() error {
	if l.ended {
		return l.err
	}
	l.ended = true
	if l.err != nil {
		return l.err
	}
	return l.scan(true)
}

// scan processes buffered input. With final=false it stops at the first
// token boundary that is not yet decidable; with final=true it drains buf.
func (l *Lexer) scan(final bool) error {
	for len(l.buf) > 0 {
		bestLen, bestRule, alive := l.match()
		if bestRule < 0 {
			// No accept seen. If every DFA is dead the error is
			// decidable now; at end of input a dangling partial
			// match is an error too.
			if !alive || final {
				l.err = &Error{Pos: l.base}
				return l.err
			}
			return nil // partial match may still complete
		}
		if alive && !final {
			return nil // tail match may still extend
		}
		tok := Token{
			Rule:  bestRule,
			Name:  l.rules[bestRule].Name,
			Text:  string(l.buf[:bestLen]),
			Start: l.base,
		}
		l.buf = l.buf[bestLen:]
		l.base += bestLen
		l.emit(tok)
	}
	return nil
}

// match runs all rule DFAs from buf[0] and returns the length and rule
// index of the best accept: longest match, ties by declaration order.
// bestRule is -1 if no rule accepts any prefix. alive reports whether any
// DFA can still consume more input, i.e. the match might still extend.
func (l *Lexer) match() (bestLen, bestRule int, alive bool) {
	bestRule = -1
	states := make([]int, len(l.rules))
	for i, r := range l.rules {
		states[i] = r.Start
	}
	for i := 0; i < len(l.buf); i++ {
		c := l.buf[i]
		alive = false
		for ri := range l.rules {
			s := states[ri]
			if s < 0 {
				continue
			}
			ns := l.rules[ri].Trans[s][c]
			states[ri] = ns
			if ns < 0 {
				continue
			}
			alive = true
			// Strictly greater keeps the earliest-declared rule
			// among accepts of equal length.
			if l.rules[ri].Accept[ns] && i+1 > bestLen {
				bestLen, bestRule = i+1, ri
			}
		}
		if !alive {
			break
		}
	}
	return bestLen, bestRule, alive
}

// Tokenize lexes a complete string in one shot. It is the reference
// semantics that streaming Writes plus End must reproduce for any chunking.
func Tokenize(s string, rules ...Rule) (toks []Token, err error) {
	lx := New(func(t Token) { toks = append(toks, t) }, rules...)
	if err = lx.Write([]byte(s)); err != nil {
		return toks, err
	}
	if err = lx.End(); err != nil {
		return toks, err
	}
	return toks, nil
}
