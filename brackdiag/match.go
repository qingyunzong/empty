package brackdiag

import "strings"

// Pair is a matched bracket pair (absolute offsets).
type Pair struct {
	Open  int
	Close int
}

// Unmatched is a bracket with no counterpart.
type Unmatched struct {
	Off int
	Ch  byte
}

// Diag is the result of bracket diagnostics.
type Diag struct {
	Pairs     []Pair      // matched pairs, ordered by closing offset
	Unmatched []Unmatched // unmatched brackets, ordered by offset
	ErrOff    int         // offset of the earliest unmatched bracket, -1 if none
}

// Match pairs brackets from the token stream with a stack.
// A closing bracket that does not match the innermost open bracket
// (or appears with nothing open) is reported as unmatched and skipped.
func Match(toks []Tok) Diag {
	var d Diag
	d.ErrOff = -1
	var stack []Tok
	noteErr := func(off int) {
		if d.ErrOff < 0 {
			d.ErrOff = off
		}
	}
	for _, t := range toks {
		if isOpen(t.Ch) {
			stack = append(stack, t)
			continue
		}
		if len(stack) == 0 || stack[len(stack)-1].Ch != MatchOpen(t.Ch) {
			d.Unmatched = append(d.Unmatched, Unmatched{Off: t.Off, Ch: t.Ch})
			noteErr(t.Off)
			continue
		}
		open := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		d.Pairs = append(d.Pairs, Pair{Open: open.Off, Close: t.Off})
	}
	// Leftover opens are unmatched; stack order is ascending by offset.
	for _, t := range stack {
		d.Unmatched = append(d.Unmatched, Unmatched{Off: t.Off, Ch: t.Ch})
		noteErr(t.Off)
	}
	// Unmatched closes were appended in scan order and precede leftover
	// opens, but a leftover open may sit before a later unmatched close.
	// Keep Unmatched sorted by offset for a stable, canonical result.
	sortUnmatched(d.Unmatched)
	return d
}

func sortUnmatched(u []Unmatched) {
	for i := 1; i < len(u); i++ {
		for j := i; j > 0 && u[j-1].Off > u[j].Off; j-- {
			u[j-1], u[j] = u[j], u[j-1]
		}
	}
}

// Scan lexes text in one pass and returns its bracket diagnostics.
// It is the reference full-scan result that incremental edits must match.
// It is implemented independently of Document's line cache.
func Scan(text string) Diag {
	var toks []Tok
	st := SNormal
	start := 0
	for start <= len(text) {
		end := strings.IndexByte(text[start:], '\n')
		var line string
		if end < 0 {
			line = text[start:]
		} else {
			line = text[start : start+end]
		}
		lt, ns := lexLine(line, st)
		for _, t := range lt {
			toks = append(toks, Tok{Off: start + t.Off, Ch: t.Ch})
		}
		st = ns
		if end < 0 {
			break
		}
		start += end + 1
	}
	return Match(toks)
}
