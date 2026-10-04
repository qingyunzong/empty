// Package rsp expands response files ("@file" arguments) for command-line
// parsers. Response files may reference further response files, may use
// single/double quotes and backslash escapes, and nested references are
// resolved relative to the directory of the file that contains them.
//
// Expansion is performed over the whole argument sequence first; the "--"
// option terminator is only meaningful afterwards, applied to the fully
// expanded sequence (see SplitOptions). A "--" inside a response file does
// not stop expansion of the remaining arguments.
package rsp

import (
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
)

// FileSystem abstracts file reads so tests can use a virtual file table.
type FileSystem interface {
	ReadFile(name string) ([]byte, error)
}

// OSFS reads response files from the operating system.
type OSFS struct{}

// ReadFile implements FileSystem using os.ReadFile.
func (OSFS) ReadFile(name string) ([]byte, error) { return readFileOS(name) }

// MapFS is an in-memory FileSystem keyed by canonical (absolute, cleaned)
// path. It is convenient for tests and virtual file tables.
type MapFS map[string]string

// ReadFile implements FileSystem.
func (m MapFS) ReadFile(name string) ([]byte, error) {
	content, ok := m[canonical(name)]
	if !ok {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
	}
	return []byte(content), nil
}

// SourceRange identifies where a token came from. File is empty for tokens
// that appeared literally on the command line; otherwise it is the canonical
// path of the response file. Start and End are byte offsets into the file
// content covering the token's raw (quoted/escaped) text.
type SourceRange struct {
	File  string
	Start int
	End   int
}

// Token is one expanded argument together with its provenance.
type Token struct {
	Text   string
	Source SourceRange
}

// CycleError reports a response file that (transitively) includes itself.
// Chain holds canonical paths from the file that introduced the cycle
// through to the repeated file, e.g. [a.rsp b.rsp a.rsp].
type CycleError struct {
	Chain []string
}

// Error implements error.
func (e *CycleError) Error() string {
	return "rsp: response file cycle: " + strings.Join(e.Chain, " -> ")
}

// canonical normalizes a path for cycle detection and MapFS lookups:
// cleaned and made absolute (against the working directory when relative).
func canonical(name string) string {
	abs, err := filepath.Abs(filepath.Clean(name))
	if err != nil {
		return filepath.Clean(name)
	}
	return abs
}

// resolve resolves a "@file" reference found inside includingFile (empty for
// the command line) to the path that should be read.
func resolve(ref, includingFile string) string {
	if filepath.IsAbs(ref) || includingFile == "" {
		return ref
	}
	return filepath.Join(filepath.Dir(includingFile), ref)
}

// Expand recursively expands "@file" arguments found in args, reading file
// contents from fsys. Tokens carry source ranges so callers can report where
// each argument originated. A token that is exactly "@" or does not start
// with "@" is passed through unchanged. The "--" terminator is passed
// through like any other token and does not stop expansion; it only gains
// meaning when SplitOptions is applied to the expanded sequence.
func Expand(args []string, fsys FileSystem) ([]Token, error) {
	if fsys == nil {
		fsys = OSFS{}
	}
	var out []Token
	for _, arg := range args {
		toks, err := expandArg(arg, "", nil, fsys)
		if err != nil {
			return nil, err
		}
		out = append(out, toks...)
	}
	return out, nil
}

// expandArg expands a single argument. stack holds the canonical paths of
// the response files currently being expanded, outermost first.
func expandArg(arg, includingFile string, stack []string, fsys FileSystem) ([]Token, error) {
	if len(arg) < 2 || arg[0] != '@' {
		return []Token{{Text: arg}}, nil
	}
	name := canonical(resolve(arg[1:], includingFile))
	for i, seen := range stack {
		if seen == name {
			return nil, &CycleError{Chain: append(append([]string{}, stack[i:]...), name)}
		}
	}
	content, err := fsys.ReadFile(name)
	if err != nil {
		return nil, fmt.Errorf("rsp: cannot read response file %s: %w", name, err)
	}
	inner, err := tokenize(string(content), name)
	if err != nil {
		return nil, err
	}
	var out []Token
	for _, tok := range inner {
		expanded, err := expandArg(tok.Text, name, append(stack, name), fsys)
		if err != nil {
			return nil, err
		}
		// Preserve the source range of the token as written in this file
		// unless it was itself a nested response file expansion.
		if len(expanded) == 1 && expanded[0].Source.File == "" {
			expanded[0].Source = tok.Source
		}
		out = append(out, expanded...)
	}
	return out, nil
}

// Texts returns just the text of each token, in order.
func Texts(tokens []Token) []string {
	out := make([]string, len(tokens))
	for i, tok := range tokens {
		out[i] = tok.Text
	}
	return out
}

// SplitOptions splits an expanded token sequence at the first "--" token:
// tokens before it are options, tokens from "--" onward are positional
// (the "--" itself is included as the first positional token, mirroring
// common argument-vector conventions). Because it operates on the fully
// expanded sequence, a "--" originating inside a response file terminates
// option processing for the whole sequence exactly as if it had been
// written on the command line.
func SplitOptions(tokens []Token) (options, positional []Token) {
	for i, tok := range tokens {
		if tok.Text == "--" {
			return tokens[:i], tokens[i:]
		}
	}
	return tokens, nil
}

// IsNotExist reports whether err indicates a missing response file.
func IsNotExist(err error) bool { return errors.Is(err, fs.ErrNotExist) }
