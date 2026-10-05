// Package rsp implements command-line argument expansion with response
// files ("@file" arguments), quoting and escaping, recursive includes,
// cycle detection, and "--" option termination.
//
// Expansion is performed before option termination: the argument list is
// first flattened into a single token sequence, and a "--" token anywhere
// in that fully expanded sequence terminates option processing for the
// remainder of the whole sequence.
package rsp

import (
	"fmt"
	"strings"
)

// Source locates the origin of a token. File is the canonical path of the
// response file the token came from, or "" for a token supplied directly
// on the command line. Start and End are byte offsets into the file
// content; they are zero for command-line tokens.
type Source struct {
	File  string
	Start int
	End   int
}

// Token is a single expanded argument together with its origin.
type Token struct {
	Text   string
	Source Source
}

// FS abstracts the file system so response files can come from the real
// file system or an in-memory table.
type FS interface {
	// ReadFile returns the content of path.
	ReadFile(path string) ([]byte, error)
	// Resolve combines ref (the text after "@") with dir, the directory
	// of the including file ("" for the command line), into a path
	// suitable for ReadFile.
	Resolve(dir, ref string) string
	// Canonical returns the canonical form of path, used for cycle
	// detection and reported in Source.File.
	Canonical(path string) (string, error)
}

// CycleError reports a response file that (transitively) includes itself.
// Chain lists the canonical paths of the include stack, ending with the
// repeated file.
type CycleError struct {
	Chain []string
}

func (e *CycleError) Error() string {
	return "response file cycle: " + strings.Join(e.Chain, " -> ")
}

// Expand recursively expands "@file" arguments into a flat token sequence.
// A token of exactly "@" is passed through literally.
func Expand(fs FS, args []string) ([]Token, error) {
	var out []Token
	var stack []string

	var expandTokens func(tokens []Token) error
	expandTokens = func(tokens []Token) error {
		for _, tok := range tokens {
			ref, ok := strings.CutPrefix(tok.Text, "@")
			if !ok || ref == "" {
				out = append(out, tok)
				continue
			}
			dir := ""
			if tok.Source.File != "" {
				dir = dirOf(tok.Source.File)
			}
			path := fs.Resolve(dir, ref)
			canon, err := fs.Canonical(path)
			if err != nil {
				return fmt.Errorf("%s: %w", path, err)
			}
			for _, open := range stack {
				if open == canon {
					return &CycleError{Chain: append(append([]string{}, stack...), canon)}
				}
			}
			content, err := fs.ReadFile(canon)
			if err != nil {
				return fmt.Errorf("%s: %w", canon, err)
			}
			inner, err := tokenize(canon, string(content))
			if err != nil {
				return err
			}
			stack = append(stack, canon)
			err = expandTokens(inner)
			stack = stack[:len(stack)-1]
			if err != nil {
				return err
			}
		}
		return nil
	}

	top := make([]Token, len(args))
	for i, a := range args {
		top[i] = Token{Text: a}
	}
	if err := expandTokens(top); err != nil {
		return nil, err
	}
	return out, nil
}

// Args is the result of splitting an expanded token sequence at "--".
type Args struct {
	// Options are the tokens before the first "--".
	Options []Token
	// Positional are the tokens after the first "--". A literal "--"
	// inside a response file also terminates options, because expansion
	// flattens everything into one sequence first.
	Positional []Token
	// Terminated reports whether a "--" token was present.
	Terminated bool
}

// Split divides an expanded token sequence at the first "--" token.
func Split(tokens []Token) Args {
	for i, tok := range tokens {
		if tok.Text == "--" {
			return Args{
				Options:    tokens[:i],
				Positional: tokens[i+1:],
				Terminated: true,
			}
		}
	}
	return Args{Options: tokens}
}

// Parse expands args with Expand and splits the result at "--".
func Parse(fs FS, args []string) (Args, error) {
	tokens, err := Expand(fs, args)
	if err != nil {
		return Args{}, err
	}
	return Split(tokens), nil
}

// dirOf returns the directory portion of a canonical path, using the
// platform-independent "/" separator that both OSFS and MapFS produce.
func dirOf(path string) string {
	if i := strings.LastIndexByte(path, '/'); i >= 0 {
		return path[:i]
	}
	return ""
}

// tokenize splits response file content into tokens. Tokens are separated
// by whitespace. Single quotes preserve their contents literally; double
// quotes preserve whitespace and allow backslash escapes; outside quotes a
// backslash escapes the next character. Token spans cover the raw source
// text including quotes.
func tokenize(file, content string) ([]Token, error) {
	var tokens []Token
	i := 0
	for i < len(content) {
		if isSpace(content[i]) {
			i++
			continue
		}
		start := i
		var text strings.Builder
		for i < len(content) && !isSpace(content[i]) {
			switch c := content[i]; c {
			case '\'':
				i++
				for i < len(content) && content[i] != '\'' {
					text.WriteByte(content[i])
					i++
				}
				if i >= len(content) {
					return nil, fmt.Errorf("%s:%d: unterminated single quote", file, start)
				}
				i++
			case '"':
				i++
				for i < len(content) && content[i] != '"' {
					if content[i] == '\\' && i+1 < len(content) {
						i++
					}
					text.WriteByte(content[i])
					i++
				}
				if i >= len(content) {
					return nil, fmt.Errorf("%s:%d: unterminated double quote", file, start)
				}
				i++
			case '\\':
				if i+1 < len(content) {
					i++
					text.WriteByte(content[i])
					i++
				} else {
					text.WriteByte(c)
					i++
				}
			default:
				text.WriteByte(c)
				i++
			}
		}
		tokens = append(tokens, Token{
			Text:   text.String(),
			Source: Source{File: file, Start: start, End: i},
		})
	}
	return tokens, nil
}

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r'
}
