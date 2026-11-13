package dataeng

import (
	"fmt"
	"math"
	"os"
	"strings"
)

// Parse reads a configuration document and returns its root table.
//
// The accepted grammar is a subset of TOML:
//   - bare and quoted dotted keys, e.g. a.b."c d" = 1
//   - table headers [a.b] and array-of-table headers [[a.b]]
//   - string, integer, float, boolean and array values, plus inline tables
//   - '#' line comments
//
// Dotted keys create implicit parent tables. A parent that was explicitly
// defined as a non-table value blocks every later write into it. Basic keys
// cannot be assigned twice. Array-of-table headers append a new table instead
// of replacing an existing table.
func Parse(src string) (*Table, error) {
	p := &parser{
		lex:     newLexer(src),
		root:    NewTable(),
		current: nil,
		defined: map[string]bool{},
	}
	if err := p.parseDocument(); err != nil {
		return nil, err
	}
	return p.root, nil
}

// ParseFile reads and parses the configuration file at path.
func ParseFile(path string) (*Table, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return Parse(string(data))
}

type parser struct {
	lex     *lexer
	buf     []token
	root    *Table
	current *Table
	// depth counts open brackets/braces. Newlines are only statement
	// terminators at depth zero; inside arrays and inline tables they are
	// insignificant.
	depth int
	// defined records full dotted paths of explicitly defined standard
	// tables, so a table header cannot reopen or redefine one.
	defined map[string]bool
}

func (p *parser) errf(tok token, format string, args ...any) error {
	return &ParseError{Line: tok.line, Column: tok.col, Msg: fmt.Sprintf(format, args...)}
}

// fill ensures the buffer contains a non-newline token at index n.
func (p *parser) fill(n int) error {
	for len(p.buf) <= n {
		tok, err := p.lex.next()
		if err != nil {
			return err
		}
		if tok.kind == tokNewline && p.depth > 0 {
			continue
		}
		p.buf = append(p.buf, tok)
	}
	return nil
}

func (p *parser) peek(n int) (token, error) {
	if err := p.fill(n); err != nil {
		return token{}, err
	}
	return p.buf[n], nil
}

func (p *parser) consume() (token, error) {
	if err := p.fill(0); err != nil {
		return token{}, err
	}
	tok := p.buf[0]
	p.buf = p.buf[1:]
	return tok, nil
}

func (p *parser) expect(kind tokenKind, what string) (token, error) {
	tok, err := p.consume()
	if err != nil {
		return token{}, err
	}
	if tok.kind != kind {
		return token{}, p.errf(tok, "expected %s, found %q", what, tok.text)
	}
	return tok, nil
}

func (p *parser) parseDocument() error {
	for {
		tok, err := p.peek(0)
		if err != nil {
			return err
		}
		if tok.kind == tokNewline {
			p.consume()
			continue
		}
		switch tok.kind {
		case tokEOF:
			return nil
		case tokLBracket:
			if err := p.parseTableHeader(); err != nil {
				return err
			}
		default:
			if err := p.parseKeyValue(p.current); err != nil {
				return err
			}
		}
	}
}

// parseTableHeader handles [a.b] and [[a.b]]. Nothing but whitespace,
// comments and the trailing newline may follow the header on the line.
func (p *parser) parseTableHeader() error {
	p.consume() // '['
	arrayTable := false
	if next, err := p.peek(0); err != nil {
		return err
	} else if next.kind == tokLBracket {
		arrayTable = true
		p.consume()
	}

	path, err := p.parseKeyPath()
	if err != nil {
		return err
	}

	if arrayTable {
		if _, err := p.expect(tokRBracket, "']'"); err != nil {
			return err
		}
	}
	closeTok, err := p.expect(tokRBracket, "']'")
	if err != nil {
		return err
	}

	rawNext, err := p.lex.next()
	if err != nil {
		return err
	}
	if rawNext.kind != tokNewline && rawNext.kind != tokEOF {
		return p.errf(rawNext, "unexpected %q after table header", rawNext.text)
	}

	if arrayTable {
		p.current, err = p.openArrayTable(path, closeTok)
	} else {
		p.current, err = p.openTable(path, closeTok)
	}
	return err
}

// parseKeyValue parses key = value into target, honoring dotted keys and
// implicit parent tables.
func (p *parser) parseKeyValue(target *Table) error {
	if target == nil {
		target = p.root
	}
	keyTok, err := p.peek(0)
	if err != nil {
		return err
	}
	path, err := p.parseKeyPath()
	if err != nil {
		return err
	}
	if _, err := p.expect(tokEqual, "'='"); err != nil {
		return err
	}
	value, err := p.parseValue()
	if err != nil {
		return err
	}

	rawNext, err := p.lex.next()
	if err != nil {
		return err
	}
	if rawNext.kind != tokNewline && rawNext.kind != tokEOF {
		// Newlines inside arrays/inline tables are fine: the buffered parser
		// only reaches here at a statement boundary.
		return p.errf(rawNext, "unexpected %q after value", rawNext.text)
	}

	return p.assignPath(target, path, value, keyTok)
}

func (p *parser) parseKeyPath() ([]string, error) {
	first, err := p.parseKeyPart()
	if err != nil {
		return nil, err
	}
	path := []string{first}
	for {
		next, err := p.peek(0)
		if err != nil {
			return nil, err
		}
		if next.kind != tokDot {
			return path, nil
		}
		p.consume()
		part, err := p.parseKeyPart()
		if err != nil {
			return nil, err
		}
		path = append(path, part)
	}
}

func (p *parser) parseKeyPart() (string, error) {
	tok, err := p.consume()
	if err != nil {
		return "", err
	}
	switch tok.kind {
	case tokString:
		if tok.text == "" {
			return "", p.errf(tok, "empty key")
		}
		return tok.text, nil
	case tokWord:
		return tok.text, nil
	default:
		return "", p.errf(tok, "expected key, found %q", tok.text)
	}
}

func (p *parser) parseValue() (any, error) {
	tok, err := p.consume()
	if err != nil {
		return nil, err
	}
	switch tok.kind {
	case tokString:
		return tok.text, nil
	case tokLBracket:
		return p.parseArray(tok)
	case tokLBrace:
		return p.parseInlineTable(tok)
	case tokWord:
		return p.parseScalar(tok)
	default:
		return nil, p.errf(tok, "expected value, found %q", tok.text)
	}
}

func (p *parser) parseArray(open token) ([]any, error) {
	p.depth++
	defer func() { p.depth-- }()
	var values []any
	for {
		next, err := p.peek(0)
		if err != nil {
			return nil, err
		}
		if next.kind == tokRBracket {
			p.consume()
			return values, nil
		}
		value, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		values = append(values, value)

		after, err := p.peek(0)
		if err != nil {
			return nil, err
		}
		switch after.kind {
		case tokComma:
			p.consume()
		case tokRBracket:
			p.consume()
			return values, nil
		default:
			return nil, p.errf(after, "expected ',' or ']' in array, found %q", after.text)
		}
	}
}

// parseInlineTable parses { key = value, ... }. Inline tables live on a
// single line: newlines are never consumed while tokens are buffered.
func (p *parser) parseInlineTable(open token) (*Table, error) {
	p.depth++
	defer func() { p.depth-- }()
	table := NewTable()
	next, err := p.peek(0)
	if err != nil {
		return nil, err
	}
	if next.kind == tokRBrace {
		p.consume()
		return table, nil
	}
	seen := map[string]bool{}
	for {
		path, err := p.parseKeyPath()
		if err != nil {
			return nil, err
		}
		if _, err := p.expect(tokEqual, "'='"); err != nil {
			return nil, err
		}
		value, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		if err := p.assignInlinePath(table, path, value, seen, open); err != nil {
			return nil, err
		}

		after, err := p.peek(0)
		if err != nil {
			return nil, err
		}
		switch after.kind {
		case tokComma:
			p.consume()
			closing, err := p.peek(0)
			if err != nil {
				return nil, err
			}
			if closing.kind == tokRBrace {
				return nil, p.errf(closing, "trailing comma in inline table")
			}
		case tokRBrace:
			p.consume()
			return table, nil
		default:
			return nil, p.errf(after, "expected ',' or '}' in inline table, found %q", after.text)
		}
	}
}

func (p *parser) parseScalar(tok token) (any, error) {
	switch tok.text {
	case "true":
		return true, nil
	case "false":
		return false, nil
	case "inf", "+inf":
		return math.Inf(1), nil
	case "-inf":
		return math.Inf(-1), nil
	case "nan", "+nan", "-nan":
		return math.NaN(), nil
	}

	if isInteger(tok.text) {
		value, err := parseInteger(tok.text)
		if err != nil {
			return nil, p.errf(tok, "%s", err.Error())
		}
		return value, nil
	}
	if isFloat(tok.text) {
		value, err := parseFloat(tok.text)
		if err != nil {
			return nil, p.errf(tok, "%s", err.Error())
		}
		return value, nil
	}
	return nil, p.errf(tok, "invalid value %q", tok.text)
}

// openTable resolves a [a.b.c] header to an existing or newly created table.
func (p *parser) openTable(path []string, at token) (*Table, error) {
	full := strings.Join(path, ".")
	if p.defined[full] {
		return nil, p.errf(at, "table %q is already defined", full)
	}

	cur := p.root
	for _, key := range path {
		existing, ok := cur.values[key]
		if !ok {
			child := NewTable()
			cur.Set(key, child)
			cur = child
			continue
		}
		child, isTable := existing.(*Table)
		if !isTable {
			return nil, p.errf(at, "key %q is not a table", key)
		}
		// An existing table at the terminal key is either an implicit
		// parent created by a dotted key or an element of an array of
		// tables; explicitly defined tables were rejected above.
		cur = child
	}
	p.defined[full] = true
	return cur, nil
}

// openArrayTable appends a new table to [[a.b]] and returns it. Existing
// tables are never replaced: a new element is always appended.
func (p *parser) openArrayTable(path []string, at token) (*Table, error) {
	cur := p.root
	for i, key := range path {
		last := i == len(path)-1
		existing, ok := cur.values[key]
		if !ok {
			if last {
				child := NewTable()
				cur.Set(key, []any{child})
				return child, nil
			}
			child := NewTable()
			cur.Set(key, child)
			cur = child
			continue
		}

		if last {
			arr, isArray := existing.([]any)
			if !isArray {
				return nil, p.errf(at, "key %q is not an array of tables", key)
			}
			if len(arr) > 0 {
				if _, ok := arr[0].(*Table); !ok {
					return nil, p.errf(at, "key %q is not an array of tables", key)
				}
			}
			child := NewTable()
			cur.Set(key, append(arr, child))
			return child, nil
		}

		switch node := existing.(type) {
		case *Table:
			cur = node
		case []any:
			lastElem, ok := node[len(node)-1].(*Table)
			if !ok {
				return nil, p.errf(at, "key %q is not an array of tables", key)
			}
			cur = lastElem
		default:
			return nil, p.errf(at, "key %q is not a table", key)
		}
	}
	return nil, p.errf(at, "empty array-table path")
}

// assignPath writes value at path within target, creating implicit parent
// tables for intermediate keys. It fails on duplicate basic keys and when an
// intermediate key already holds a non-table value.
func (p *parser) assignPath(target *Table, path []string, value any, at token) error {
	cur := target
	for i := 0; i < len(path)-1; i++ {
		key := path[i]
		existing, ok := cur.values[key]
		if !ok {
			child := NewTable()
			cur.Set(key, child)
			cur = child
			continue
		}
		child, isTable := existing.(*Table)
		if !isTable {
			return p.errf(at, "key %q cannot be used as a table: it already holds a non-table value", key)
		}
		cur = child
	}

	last := path[len(path)-1]
	if _, exists := cur.values[last]; exists {
		return p.errf(at, "key %q is assigned more than once", last)
	}
	cur.Set(last, value)
	return nil
}

// assignInlinePath applies the same dotted-key rules inside inline tables.
// seen tracks full sub-paths because every key in an inline table is defined
// at once, including implicit parents.
func (p *parser) assignInlinePath(table *Table, path []string, value any, seen map[string]bool, at token) error {
	var prefix strings.Builder
	for i, part := range path {
		if i > 0 {
			prefix.WriteByte('.')
		}
		prefix.WriteString(part)
		if seen[prefix.String()] {
			return p.errf(at, "key %q is assigned more than once", prefix.String())
		}
	}

	cur := table
	for i := 0; i < len(path)-1; i++ {
		key := path[i]
		existing, ok := cur.values[key]
		if !ok {
			child := NewTable()
			cur.Set(key, child)
			cur = child
			continue
		}
		child, isTable := existing.(*Table)
		if !isTable {
			return p.errf(at, "key %q cannot be used as a table: it already holds a non-table value", key)
		}
		cur = child
	}

	last := path[len(path)-1]
	if _, exists := cur.values[last]; exists {
		return p.errf(at, "key %q is assigned more than once", last)
	}
	cur.Set(last, value)

	for i := range path {
		seen[strings.Join(path[:i+1], ".")] = true
	}
	return nil
}
