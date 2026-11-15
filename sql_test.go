package dataeng

import (
	"context"
	"errors"
	"math/big"
	"strconv"
	"strings"
	"testing"
	"unicode"
)

func predicateRows() []Tuple {
	return []Tuple{
		{1, nil, nil},
		{1, nil, 2},
		{1, nil, 3},
		{1, "A", 1},
		{1, "B", nil},
		{2, nil, 1},
		{2, "a", 2},
		{nil, nil, nil},
		{nil, "z", 1},
	}
}

func predicateColumns() []KeyColumn {
	return []KeyColumn{
		{Name: "a", Kind: KindInt, Nulls: NullsLast},
		{Name: "b", Kind: KindString, Nulls: NullsFirst, Collation: foldCollation()},
		{Name: "c", Kind: KindInt, Desc: true, Nulls: NullsFirst},
	}
}

func TestPredicateMatchesChunkContains(t *testing.T) {
	cols := predicateColumns()
	rows := predicateRows()
	src, err := NewMemorySnapshot(cols, rows)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := BuildPlan(context.Background(), src, "t", Options{ChunkCount: 6})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Chunks) < 3 {
		t.Fatalf("test needs multiple chunks, got %d", len(plan.Chunks))
	}

	for _, dialect := range []Dialect{Postgres, MySQL, SQLite} {
		dialect := dialect
		t.Run(dialect.Name(), func(t *testing.T) {
			for _, chunk := range plan.Chunks {
				pred, args, err := chunk.Predicate(dialect, cols)
				if err != nil {
					t.Fatal(err)
				}
				for _, row := range rows {
					got, err := evalPredicate(pred, args, dialect, row, cols)
					if err != nil {
						t.Fatalf("%s: row %s: %v\nSQL: %s", chunk, FormatTuple(row), err, pred)
					}
					want, err := chunk.Contains(row, cols)
					if err != nil {
						t.Fatal(err)
					}
					if got != want {
						t.Fatalf("%s: row %s predicate=%v contains=%v\nSQL: %s\nargs: %v",
							chunk, FormatTuple(row), got, want, pred, args)
					}
				}
			}
		})
	}
}

func TestPostgresPredicateUsesNumberedPlaceholders(t *testing.T) {
	cols := []KeyColumn{{Name: "id", Kind: KindInt}}
	chunk := Chunk{
		Table: "t",
		Lower: InclusiveKey(Tuple{2}),
		Upper: ExclusiveKey(Tuple{5}),
	}
	pred, args, err := chunk.Predicate(Postgres, cols)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(pred, "$1") || !strings.Contains(pred, "$2") {
		t.Fatalf("missing numbered placeholders: %s", pred)
	}
	if len(args) != 2 || args[0] != 2 || args[1] != 5 {
		t.Fatalf("args = %v", args)
	}
}

func TestPredicateExhaustiveOrders(t *testing.T) {
	values := []Value{nil, 0, 1, 2}
	for ncols := 1; ncols <= 3; ncols++ {
		rows := productTuples(values, ncols)
		for mask := 0; mask < 1<<(2*ncols); mask++ {
			cols := make([]KeyColumn, ncols)
			for i := range cols {
				cols[i] = KeyColumn{
					Name:  "c" + strconv.Itoa(i),
					Kind:  KindInt,
					Desc:  mask&(1<<(2*i)) != 0,
					Nulls: NullsLast,
				}
				if mask&(1<<(2*i+1)) != 0 {
					cols[i].Nulls = NullsFirst
				}
			}
			snap, err := NewMemorySnapshot(cols, rows)
			if err != nil {
				t.Fatal(err)
			}
			plan, err := BuildPlan(context.Background(), snap, "t", Options{ChunkCount: 5})
			if err != nil {
				t.Fatalf("columns %v: %v", cols, err)
			}
			for _, dialect := range []Dialect{Postgres, MySQL, SQLite} {
				for _, chunk := range plan.Chunks {
					pred, args, err := chunk.Predicate(dialect, cols)
					if err != nil {
						t.Fatal(err)
					}
					for _, row := range rows {
						got, err := evalPredicate(pred, args, dialect, row, cols)
						if err != nil {
							t.Fatalf("columns %v row %s: %v\nSQL: %s\nargs: %v",
								cols, FormatTuple(row), err, pred, args)
						}
						want, err := chunk.Contains(row, cols)
						if err != nil {
							t.Fatal(err)
						}
						if got != want {
							t.Fatalf("columns %v\nchunk %s\nrow %s\npredicate=%v contains=%v\nSQL: %s\nargs: %v",
								cols, chunk, FormatTuple(row), got, want, pred, args)
						}
					}
				}
			}
		}
	}
}

func productTuples(values []Value, ncols int) []Tuple {
	if ncols == 0 {
		return []Tuple{{}}
	}
	var out []Tuple
	for _, prefix := range productTuples(values, ncols-1) {
		for _, v := range values {
			row := append(Tuple(nil), prefix...)
			out = append(out, append(row, v))
		}
	}
	return out
}

func TestOrderByNullEmulation(t *testing.T) {
	cols := []KeyColumn{
		{Name: "a", Kind: KindInt, Desc: true, Nulls: NullsLast},
		{Name: "b", Kind: KindString, Nulls: NullsFirst, Collation: foldCollation()},
	}
	pg := OrderBySQL(Postgres, cols)
	if !strings.Contains(pg, `"a" DESC NULLS LAST`) ||
		!strings.Contains(pg, `"b" COLLATE "NOCASE" ASC NULLS FIRST`) {
		t.Fatalf("postgres order by = %s", pg)
	}
	my := OrderBySQL(MySQL, cols)
	if !strings.Contains(my, "`a` IS NULL ASC, `a` DESC") ||
		!strings.Contains(my, "`b` IS NULL DESC, `b` COLLATE NOCASE ASC") {
		t.Fatalf("mysql order by = %s", my)
	}
}

func TestSelectSQLProjectsIdentifiers(t *testing.T) {
	cols := []KeyColumn{{Name: "id", Kind: KindInt}}
	chunk := Chunk{Table: "public.items", Lower: InclusiveKey(Tuple{2}), Upper: ExclusiveKey(Tuple{5})}
	q, err := chunk.SelectSQL(Postgres, cols, []string{"id", "payload"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(q.SQL, `SELECT "id", "payload" FROM "public"."items" WHERE `) {
		t.Fatalf("select = %s", q.SQL)
	}
	if !strings.HasSuffix(q.SQL, `ORDER BY "id" ASC NULLS LAST`) {
		t.Fatalf("select order = %s", q.SQL)
	}
}

func TestRatSQLString(t *testing.T) {
	cases := map[string]string{
		"3/2":  "1.5",
		"1/20": "0.05",
		"-7/1": "-7",
		"1/3":  "0.33333333333333333333333333333333333333",
	}
	for input, want := range cases {
		r, ok := new(big.Rat).SetString(input)
		if !ok {
			t.Fatalf("parse %q", input)
		}
		if got := ratSQLString(r); got != want {
			t.Fatalf("ratSQLString(%s) = %q, want %q", input, got, want)
		}
	}
}

func TestChunkPredicateRejectsWrongTupleLength(t *testing.T) {
	cols := []KeyColumn{{Name: "a", Kind: KindInt}, {Name: "b", Kind: KindInt}}
	chunk := Chunk{Table: "t", Lower: InclusiveKey(Tuple{1}), Upper: Unbounded()}
	if _, _, err := chunk.Predicate(Postgres, cols); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("error = %v", err)
	}
}

// The predicate evaluator below is intentionally small. It implements enough
// SQL to execute the expressions produced by Chunk.Predicate and to compare
// their semantics with Chunk.Contains. Comparisons involving NULL evaluate to
// UNKNOWN, represented as false in WHERE clauses, as SQL requires.

type predTokenKind uint8

const (
	tokEOF predTokenKind = iota
	tokLParen
	tokRParen
	tokIdent
	tokArg
	tokOp
	tokIs
	tokNot
	tokNull
	tokCollate
	tokAnd
	tokOr
	tokTrue
	tokFalse
)

type predToken struct {
	kind  predTokenKind
	text  string
	index int
}

func lexPredicate(s string, dialect Dialect) ([]predToken, error) {
	var tokens []predToken
	argIndex := 0
	for i := 0; i < len(s); {
		r := rune(s[i])
		if unicode.IsSpace(r) {
			i++
			continue
		}
		switch s[i] {
		case '(':
			tokens = append(tokens, predToken{kind: tokLParen})
			i++
		case ')':
			tokens = append(tokens, predToken{kind: tokRParen})
			i++
		case '?':
			tokens = append(tokens, predToken{kind: tokArg, index: argIndex, text: "?"})
			argIndex++
			i++
		case '$':
			j := i + 1
			for j < len(s) && s[j] >= '0' && s[j] <= '9' {
				j++
			}
			n, err := strconv.Atoi(s[i+1 : j])
			if err != nil || n < 1 {
				return nil, err
			}
			tokens = append(tokens, predToken{kind: tokArg, index: n - 1, text: s[i:j]})
			i = j
		case '>', '<', '=':
			j := i + 1
			if j < len(s) && s[j] == '=' {
				j++
			}
			tokens = append(tokens, predToken{kind: tokOp, text: s[i:j]})
			i = j
		case '"', '`':
			quote := s[i]
			i++
			var b strings.Builder
			for {
				if i >= len(s) {
					return nil, errUnclosedQuote
				}
				if s[i] == quote {
					if i+1 < len(s) && s[i+1] == quote {
						b.WriteByte(quote)
						i += 2
						continue
					}
					i++
					break
				}
				b.WriteByte(s[i])
				i++
			}
			tokens = append(tokens, predToken{kind: tokIdent, text: b.String()})
		default:
			j := i
			for j < len(s) && (unicode.IsLetter(rune(s[j])) || s[j] == '_') {
				j++
			}
			if j == i {
				return nil, errBadToken
			}
			word := strings.ToUpper(s[i:j])
			switch word {
			case "AND":
				tokens = append(tokens, predToken{kind: tokAnd})
			case "OR":
				tokens = append(tokens, predToken{kind: tokOr})
			case "IS":
				tokens = append(tokens, predToken{kind: tokIs})
			case "NOT":
				tokens = append(tokens, predToken{kind: tokNot})
			case "NULL":
				tokens = append(tokens, predToken{kind: tokNull})
			case "COLLATE":
				tokens = append(tokens, predToken{kind: tokCollate})
			case "TRUE":
				tokens = append(tokens, predToken{kind: tokTrue})
			case "FALSE":
				tokens = append(tokens, predToken{kind: tokFalse})
			default:
				tokens = append(tokens, predToken{kind: tokIdent, text: s[i:j]})
			}
			i = j
		}
	}
	return append(tokens, predToken{kind: tokEOF}), nil
}

var (
	errUnclosedQuote = &predicateError{"unclosed quoted identifier"}
	errBadToken      = &predicateError{"unexpected token"}
)

type predicateError struct{ msg string }

func (e *predicateError) Error() string { return e.msg }

type predicateParser struct {
	tokens  []predToken
	pos     int
	args    []any
	row     Tuple
	cols    []KeyColumn
	colIdx  map[string]int
	dialect Dialect
}

func evalPredicate(sql string, args []any, dialect Dialect, row Tuple, cols []KeyColumn) (bool, error) {
	if strings.TrimSpace(sql) == "" {
		return true, nil
	}
	tokens, err := lexPredicate(sql, dialect)
	if err != nil {
		return false, err
	}
	idx := make(map[string]int, len(cols))
	for i, col := range cols {
		idx[col.Name] = i
	}
	p := &predicateParser{tokens: tokens, args: args, row: row, cols: cols, colIdx: idx, dialect: dialect}
	v, err := p.parseOr()
	if err != nil {
		return false, err
	}
	if p.peek().kind != tokEOF {
		return false, &predicateError{"trailing tokens"}
	}
	return v, nil
}

func (p *predicateParser) peek() predToken { return p.tokens[p.pos] }
func (p *predicateParser) next() predToken {
	t := p.tokens[p.pos]
	p.pos++
	return t
}

func (p *predicateParser) parseOr() (bool, error) {
	left, err := p.parseAnd()
	if err != nil {
		return false, err
	}
	for p.peek().kind == tokOr {
		p.next()
		right, err := p.parseAnd()
		if err != nil {
			return false, err
		}
		left = left || right
	}
	return left, nil
}

func (p *predicateParser) parseAnd() (bool, error) {
	left, err := p.parsePrimary()
	if err != nil {
		return false, err
	}
	for p.peek().kind == tokAnd {
		p.next()
		right, err := p.parsePrimary()
		if err != nil {
			return false, err
		}
		left = left && right
	}
	return left, nil
}

func (p *predicateParser) parsePrimary() (bool, error) {
	switch p.peek().kind {
	case tokLParen:
		p.next()
		v, err := p.parseOr()
		if err != nil {
			return false, err
		}
		if p.next().kind != tokRParen {
			return false, &predicateError{"missing )"}
		}
		return v, nil
	case tokTrue:
		p.next()
		return true, nil
	case tokFalse:
		p.next()
		return false, nil
	}

	left, leftNull, leftCol, err := p.parseOperand()
	if err != nil {
		return false, err
	}
	if p.peek().kind == tokIs {
		p.next()
		not := false
		if p.peek().kind == tokNot {
			p.next()
			not = true
		}
		if p.next().kind != tokNull {
			return false, &predicateError{"expected NULL"}
		}
		isNull := leftNull
		if not {
			return !isNull, nil
		}
		return isNull, nil
	}

	opTok := p.next()
	if opTok.kind != tokOp {
		return false, &predicateError{"expected comparison"}
	}
	right, rightNull, _, err := p.parseOperand()
	if err != nil {
		return false, err
	}
	if leftNull || rightNull {
		return false, nil
	}
	// SQL comparison operators see the column's base order; direction is
	// already encoded in the operator chosen by the predicate builder.
	cmpCol := leftCol
	cmpCol.Desc = false
	cmp, err := CompareValues(left, right, cmpCol)
	if err != nil {
		return false, err
	}
	switch opTok.text {
	case "=":
		return cmp == 0, nil
	case ">":
		return cmp > 0, nil
	case ">=":
		return cmp >= 0, nil
	case "<":
		return cmp < 0, nil
	case "<=":
		return cmp <= 0, nil
	default:
		return false, &predicateError{"unknown operator " + opTok.text}
	}
}

func (p *predicateParser) parseOperand() (Value, bool, KeyColumn, error) {
	tok := p.next()
	switch tok.kind {
	case tokArg:
		if tok.index < 0 || tok.index >= len(p.args) {
			return nil, false, KeyColumn{}, &predicateError{"argument out of range"}
		}
		v := p.args[tok.index]
		return v, IsNull(v), KeyColumn{}, nil
	case tokNull:
		return nil, true, KeyColumn{}, nil
	case tokIdent:
		idx, ok := p.colIdx[tok.text]
		if !ok {
			return nil, false, KeyColumn{}, &predicateError{"unknown column " + tok.text}
		}
		if p.peek().kind == tokCollate {
			p.next()
			if p.next().kind != tokIdent {
				return nil, false, KeyColumn{}, &predicateError{"expected collation name"}
			}
		}
		v := p.row[idx]
		return v, IsNull(v), p.cols[idx], nil
	default:
		return nil, false, KeyColumn{}, &predicateError{"expected operand"}
	}
}
