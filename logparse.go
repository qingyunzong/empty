// Package logparse parses key=value log lines. Values may be quoted and
// may escape spaces; bare keys are boolean true; empty values are empty
// strings. A bad escape isolates only its physical line, which is reported
// with its raw span. Key aliases form a directed map (cycles rejected) and
// duplicate handling is based on the final canonical key.
package logparse

import "fmt"

// ValueKind discriminates Value.
type ValueKind int

const (
	// KindStr is a string value (including the empty string from "key=").
	KindStr ValueKind = iota
	// KindBool is a boolean value produced by a bare key.
	KindBool
)

// Value is a parsed value: either a string or a boolean.
type Value struct {
	Kind ValueKind
	Str  string
	Bool bool
}

// Str builds a string Value.
func Str(s string) Value { return Value{Kind: KindStr, Str: s} }

// Bool builds a boolean Value.
func Bool(b bool) Value { return Value{Kind: KindBool, Bool: b} }

func (v Value) String() string {
	if v.Kind == KindBool {
		return fmt.Sprintf("%t", v.Bool)
	}
	return v.Str
}

// Config holds parsing rules. The zero value (nil) is valid and applies no
// aliases.
type Config struct {
	aliases map[string]string
}

// NewConfig builds a Config from a directed alias map (alias -> canonical
// key). Chains are allowed; any cycle (including self-loops) is rejected.
func NewConfig(aliases map[string]string) (*Config, error) {
	c := &Config{aliases: make(map[string]string, len(aliases))}
	for k, v := range aliases {
		if k == "" {
			return nil, fmt.Errorf("logparse: empty alias key")
		}
		if v == "" {
			return nil, fmt.Errorf("logparse: empty alias target for %q", k)
		}
		c.aliases[k] = v
	}
	for k := range c.aliases {
		seen := map[string]bool{k: true}
		for cur := k; ; {
			next, ok := c.aliases[cur]
			if !ok {
				break
			}
			if seen[next] {
				return nil, fmt.Errorf("logparse: alias cycle involving %q", next)
			}
			seen[next] = true
			cur = next
		}
	}
	return c, nil
}

// Resolve follows the alias chain to the final canonical key.
func (c *Config) Resolve(key string) string {
	if c == nil {
		return key
	}
	cur := key
	for {
		next, ok := c.aliases[cur]
		if !ok {
			return cur
		}
		cur = next
	}
}

// Pair is one key=value (or bare key) occurrence on a line.
type Pair struct {
	Key    string // canonical key after alias resolution
	RawKey string // key as written on the line
	Value  Value
}

// Line is the result of parsing one physical line.
type Line struct {
	Pairs  []Pair // occurrences in order; duplicates kept
	Bad    bool   // true when a bad escape/malformed token isolated this line
	Raw    string // raw span of the physical line (newline excluded)
	Offset int    // byte offset of the line start within a Stream; 0 for Parse
}

// Values groups values by canonical key, preserving occurrence order.
func (l Line) Values() map[string][]Value {
	m := make(map[string][]Value, len(l.Pairs))
	for _, p := range l.Pairs {
		m[p.Key] = append(m[p.Key], p.Value)
	}
	return m
}

// Parse parses a single physical line (no trailing newline).
func Parse(line string, cfg *Config) Line {
	return parseLine(line, cfg, 0)
}

func badLine(raw string, off int) Line {
	return Line{Bad: true, Raw: raw, Offset: off}
}

func isSpace(c byte) bool { return c == ' ' || c == '\t' }

func parseLine(raw string, cfg *Config, off int) Line {
	l := Line{Raw: raw, Offset: off}
	i, n := 0, len(raw)
	for i < n {
		for i < n && isSpace(raw[i]) {
			i++
		}
		if i >= n {
			break
		}
		start := i
		for i < n && raw[i] != '=' && !isSpace(raw[i]) && raw[i] != '"' {
			i++
		}
		key := raw[start:i]
		if key == "" {
			return badLine(raw, off)
		}
		if i >= n || isSpace(raw[i]) {
			// Bare key: boolean true.
			l.Pairs = append(l.Pairs, Pair{Key: cfg.Resolve(key), RawKey: key, Value: Bool(true)})
			continue
		}
		if raw[i] != '=' {
			return badLine(raw, off)
		}
		i++
		val, next, ok := parseValue(raw, i)
		if !ok {
			return badLine(raw, off)
		}
		i = next
		if i < n && !isSpace(raw[i]) {
			return badLine(raw, off)
		}
		l.Pairs = append(l.Pairs, Pair{Key: cfg.Resolve(key), RawKey: key, Value: Str(val)})
	}
	return l
}

func parseValue(raw string, i int) (string, int, bool) {
	if i < len(raw) && raw[i] == '"' {
		return parseQuoted(raw, i+1)
	}
	return parseBareValue(raw, i)
}

// escape decodes an escape sequence starting at raw[i] (raw[i] == '\\').
func escape(raw string, i int) (byte, int, bool) {
	if i+1 >= len(raw) {
		return 0, 0, false
	}
	switch c := raw[i+1]; c {
	case 'n':
		return '\n', i + 2, true
	case 't':
		return '\t', i + 2, true
	case ' ', '\\', '=', '"':
		return c, i + 2, true
	}
	return 0, 0, false
}

func parseBareValue(raw string, i int) (string, int, bool) {
	n, start := len(raw), i
	var b []byte
	for i < n && !isSpace(raw[i]) {
		if raw[i] == '\\' {
			if b == nil {
				b = []byte(raw[start:i])
			}
			ch, ni, ok := escape(raw, i)
			if !ok {
				return "", 0, false
			}
			b = append(b, ch)
			i = ni
			continue
		}
		if b != nil {
			b = append(b, raw[i])
		}
		i++
	}
	if b == nil {
		return raw[start:i], i, true
	}
	return string(b), i, true
}

func parseQuoted(raw string, i int) (string, int, bool) {
	n := len(raw)
	var b []byte
	for i < n {
		c := raw[i]
		if c == '"' {
			return string(b), i + 1, true
		}
		if c == '\\' {
			ch, ni, ok := escape(raw, i)
			if !ok {
				return "", 0, false
			}
			b = append(b, ch)
			i = ni
			continue
		}
		b = append(b, c)
		i++
	}
	return "", 0, false // unterminated quote
}
