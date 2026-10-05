// Package brackdiag provides source-code bracket diagnostics.
// It lexes text while ignoring brackets inside string literals,
// character literals, raw strings and comments, and reports
// matched bracket pairs and unmatched bracket positions.
package brackdiag

// State is the lexical state at a line boundary.
// Only SBlockComment and SRawString carry across lines.
type State int

const (
	SNormal State = iota
	SLineComment
	SBlockComment
	SString
	SChar
	SRawString
)

// Tok is a bracket token found outside strings and comments.
type Tok struct {
	Off int  // byte offset (relative to the lexed line)
	Ch  byte // one of ( ) [ ] { }
}

func isOpen(c byte) bool  { return c == '(' || c == '[' || c == '{' }
func isClose(c byte) bool { return c == ')' || c == ']' || c == '}' }

// MatchOpen returns the opening bracket for a closing bracket.
func MatchOpen(c byte) byte {
	switch c {
	case ')':
		return '('
	case ']':
		return '['
	case '}':
		return '{'
	}
	return 0
}

// lexLine lexes a single line (without the trailing newline) starting
// in state st, returning bracket tokens (offsets relative to the line
// start) and the state at the end of the line.
func lexLine(s string, st State) ([]Tok, State) {
	var toks []Tok
	i := 0
	for i < len(s) {
		switch st {
		case SNormal:
			c := s[i]
			switch {
			case c == '/' && i+1 < len(s) && s[i+1] == '/':
				st = SLineComment
				i += 2
			case c == '/' && i+1 < len(s) && s[i+1] == '*':
				st = SBlockComment
				i += 2
			case c == '"':
				st = SString
				i++
			case c == '\'':
				st = SChar
				i++
			case c == '`':
				st = SRawString
				i++
			case isOpen(c) || isClose(c):
				toks = append(toks, Tok{Off: i, Ch: c})
				i++
			default:
				i++
			}
		case SLineComment:
			i = len(s)
		case SBlockComment:
			if s[i] == '*' && i+1 < len(s) && s[i+1] == '/' {
				st = SNormal
				i += 2
			} else {
				i++
			}
		case SString:
			if s[i] == '\\' {
				i += 2
			} else if s[i] == '"' {
				st = SNormal
				i++
			} else {
				i++
			}
		case SChar:
			if s[i] == '\\' {
				i += 2
			} else if s[i] == '\'' {
				st = SNormal
				i++
			} else {
				i++
			}
		case SRawString:
			if s[i] == '`' {
				st = SNormal
				i++
			} else {
				i++
			}
		}
	}
	// Line comments and unterminated string/char literals end at EOL.
	if st == SLineComment || st == SString || st == SChar {
		st = SNormal
	}
	return toks, st
}
