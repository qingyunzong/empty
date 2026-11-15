package dataeng

import (
	"encoding/json"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"time"
)

// Dialect renders identifiers, placeholders and collations for one SQL
// engine. The predicate generator is dialect-independent because it expands
// tuple comparisons lexicographically and handles NULL and collation explicitly.
type Dialect interface {
	Name() string
	QuoteIdentifier(name string) string
	Placeholder(index int) string
	Collate(expr, collation string) string
	SupportsNullsOrdering() bool
}

// PostgresDialect renders SQL for PostgreSQL.
type PostgresDialect struct{}

func (PostgresDialect) Name() string { return "postgres" }

func (PostgresDialect) QuoteIdentifier(name string) string {
	return quoteQualified(name, `"`, `"`)
}

func (PostgresDialect) Placeholder(index int) string { return fmt.Sprintf("$%d", index) }

func (PostgresDialect) Collate(expr, collation string) string {
	return expr + " COLLATE " + quoteQualified(collation, `"`, `"`)
}

func (PostgresDialect) SupportsNullsOrdering() bool { return true }

// MySQLDialect renders SQL for MySQL 8.0 and later. MySQL does not accept
// NULLS FIRST/LAST, so ORDER BY prefixes a portable (expr IS NULL) key.
type MySQLDialect struct{}

func (MySQLDialect) Name() string { return "mysql" }

func (MySQLDialect) QuoteIdentifier(name string) string {
	return quoteQualified(name, "`", "`")
}

func (MySQLDialect) Placeholder(int) string { return "?" }

func (MySQLDialect) Collate(expr, collation string) string {
	return expr + " COLLATE " + sqlToken(collation, "`")
}

func (MySQLDialect) SupportsNullsOrdering() bool { return false }

// SQLiteDialect renders SQL for SQLite.
type SQLiteDialect struct{}

func (SQLiteDialect) Name() string { return "sqlite" }

func (SQLiteDialect) QuoteIdentifier(name string) string {
	return quoteQualified(name, `"`, `"`)
}

func (SQLiteDialect) Placeholder(int) string { return "?" }

func (SQLiteDialect) Collate(expr, collation string) string {
	return expr + " COLLATE " + sqlToken(collation, `"`)
}

func (SQLiteDialect) SupportsNullsOrdering() bool { return true }

var (
	// Postgres is the built-in PostgreSQL dialect.
	Postgres PostgresDialect
	// MySQL is the built-in MySQL dialect.
	MySQL MySQLDialect
	// SQLite is the built-in SQLite dialect.
	SQLite SQLiteDialect
)

func quoteQualified(name, open, close string) string {
	if name == "" {
		return open + close
	}
	parts := strings.Split(name, ".")
	for i, part := range parts {
		parts[i] = open + strings.ReplaceAll(part, close, close+close) + close
	}
	return strings.Join(parts, ".")
}

func sqlToken(token, quote string) string {
	if token == "" {
		return quote + quote
	}
	for _, r := range token {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || r == '_' {
			continue
		}
		return quoteQualified(token, quote, quote)
	}
	return token
}

// Query is a parameterized SQL statement.
type Query struct {
	SQL  string
	Args []any
}

// Predicate returns the WHERE expression for this chunk, without the WHERE
// keyword. It returns an empty expression for a fully unbounded chunk.
//
// The expression is an explicit half-open tuple comparison. For example, for
// two ascending key columns it expands to
//
//	(c1 > b1) OR (c1 = b1 AND c2 >= b2)  -- lower bound
//	(c1 < b1) OR (c1 = b1 AND c2 < b2)   -- upper bound
//
// NULL placement and collations are expanded into the comparison terms, because
// SQL row constructors do not provide configurable NULL ordering.
func (c Chunk) Predicate(d Dialect, cols []KeyColumn) (string, []any, error) {
	if d == nil {
		return "", nil, fmt.Errorf("%w: nil SQL dialect", ErrInvalidPlan)
	}
	if err := ValidateColumns(cols); err != nil {
		return "", nil, err
	}
	if !c.Lower.IsUnbounded() && len(c.Lower.Value) != len(cols) {
		return "", nil, fmt.Errorf("%w: lower key has %d values, want %d",
			ErrInvalidKey, len(c.Lower.Value), len(cols))
	}
	if !c.Upper.IsUnbounded() && len(c.Upper.Value) != len(cols) {
		return "", nil, fmt.Errorf("%w: upper key has %d values, want %d",
			ErrInvalidKey, len(c.Upper.Value), len(cols))
	}

	ph := &placeholders{}
	var parts []string
	if !c.Lower.IsUnbounded() {
		expr, err := boundPredicate(d, ph, cols, c.Lower.Value, true)
		if err != nil {
			return "", nil, err
		}
		parts = append(parts, expr)
	}
	if !c.Upper.IsUnbounded() {
		expr, err := boundPredicate(d, ph, cols, c.Upper.Value, false)
		if err != nil {
			return "", nil, err
		}
		parts = append(parts, expr)
	}
	if len(parts) == 0 {
		return "", nil, nil
	}
	for i, part := range parts {
		parts[i] = "(" + part + ")"
	}
	return ph.render(d, strings.Join(parts, " AND "))
}

// SelectSQL builds a deterministic, non-paginated SELECT for the complete
// chunk. projection entries are identifiers; an empty projection selects *.
// No LIMIT or OFFSET is emitted.
func (c Chunk) SelectSQL(d Dialect, cols []KeyColumn, projection []string) (Query, error) {
	if d == nil {
		return Query{}, fmt.Errorf("%w: nil SQL dialect", ErrInvalidPlan)
	}
	where, args, err := c.Predicate(d, cols)
	if err != nil {
		return Query{}, err
	}
	selectList := "*"
	if len(projection) > 0 {
		quoted := make([]string, len(projection))
		for i, name := range projection {
			if name == "*" {
				quoted[i] = "*"
			} else {
				quoted[i] = d.QuoteIdentifier(name)
			}
		}
		selectList = strings.Join(quoted, ", ")
	}
	var b strings.Builder
	fmt.Fprintf(&b, "SELECT %s FROM %s", selectList, d.QuoteIdentifier(c.Table))
	if where != "" {
		b.WriteString(" WHERE ")
		b.WriteString(where)
	}
	b.WriteString(" ORDER BY ")
	b.WriteString(orderBySQL(d, cols))
	return Query{SQL: b.String(), Args: args}, nil
}

// CountSQL builds a COUNT(*) query constrained to this chunk.
func (c Chunk) CountSQL(d Dialect, cols []KeyColumn) (Query, error) {
	if d == nil {
		return Query{}, fmt.Errorf("%w: nil SQL dialect", ErrInvalidPlan)
	}
	where, args, err := c.Predicate(d, cols)
	if err != nil {
		return Query{}, err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "SELECT COUNT(*) FROM %s", d.QuoteIdentifier(c.Table))
	if where != "" {
		b.WriteString(" WHERE ")
		b.WriteString(where)
	}
	return Query{SQL: b.String(), Args: args}, nil
}

// Queries returns one SELECT per chunk. All queries are intended to run inside
// the same snapshot as p.Snapshot. SQL contains no OFFSET pagination.
func (p *Plan) Queries(d Dialect, projection []string) ([]Query, error) {
	if p == nil {
		return nil, fmt.Errorf("%w: nil plan", ErrInvalidPlan)
	}
	queries := make([]Query, 0, len(p.Chunks))
	for _, chunk := range p.Chunks {
		q, err := chunk.SelectSQL(d, p.KeyColumns, projection)
		if err != nil {
			return nil, fmt.Errorf("chunk %d: %w", chunk.Index, err)
		}
		queries = append(queries, q)
	}
	return queries, nil
}

// OrderBySQL returns the ORDER BY clause for the key, including direction,
// NULL placement and collation.
func OrderBySQL(d Dialect, cols []KeyColumn) string {
	return orderBySQL(d, cols)
}

func orderBySQL(d Dialect, cols []KeyColumn) string {
	if d == nil {
		return ""
	}
	parts := make([]string, 0, len(cols))
	for _, col := range cols {
		expr := d.QuoteIdentifier(col.Name)
		if col.Collation != nil && col.Collation.Name() != "" {
			expr = d.Collate(expr, col.Collation.Name())
		}
		dir := " ASC"
		if col.Desc {
			dir = " DESC"
		}
		if d.SupportsNullsOrdering() {
			parts = append(parts, expr+dir+" "+col.Nulls.String())
			continue
		}
		nullFlag := d.QuoteIdentifier(col.Name) + " IS NULL"
		if col.Nulls == NullsFirst {
			parts = append(parts, nullFlag+" DESC", expr+dir)
		} else {
			parts = append(parts, nullFlag+" ASC", expr+dir)
		}
	}
	return strings.Join(parts, ", ")
}

type placeholders struct {
	args []any
}

func (p *placeholders) value(v Value) string {
	idx := len(p.args)
	if IsNull(v) {
		p.args = append(p.args, nil)
	} else {
		p.args = append(p.args, sqlValue(v))
	}
	return "\x00" + strconv.Itoa(idx) + "\x00"
}

// render replaces internal argument markers in their final textual order. SQL
// placeholders are numbered by appearance, which is required by dialects that
// use positional '?' placeholders.
func (p *placeholders) render(d Dialect, expr string) (string, []any, error) {
	var sql strings.Builder
	args := make([]any, 0, len(p.args))
	for {
		start := strings.IndexByte(expr, 0)
		if start < 0 {
			sql.WriteString(expr)
			break
		}
		sql.WriteString(expr[:start])
		expr = expr[start+1:]
		end := strings.IndexByte(expr, 0)
		if end < 0 {
			return "", nil, fmt.Errorf("%w: malformed SQL argument marker", ErrInvalidPlan)
		}
		idx, err := strconv.Atoi(expr[:end])
		if err != nil || idx < 0 || idx >= len(p.args) {
			return "", nil, fmt.Errorf("%w: malformed SQL argument index %q",
				ErrInvalidPlan, expr[:end])
		}
		args = append(args, p.args[idx])
		sql.WriteString(d.Placeholder(len(args)))
		expr = expr[end+1:]
	}
	return sql.String(), args, nil
}

func sqlValue(v Value) any {
	switch x := v.(type) {
	case *big.Int:
		return x.String()
	case *big.Rat:
		return ratSQLString(x)
	case *big.Float:
		return x.Text('g', -1)
	case json.Number:
		return string(x)
	case time.Time:
		return x
	default:
		return v
	}
}

// ratSQLString renders a rational as an exact decimal when the denominator
// only contains factors of 2 and 5. Database numeric parameters do not accept
// the "numerator/denominator" syntax used by Rat.String.
func ratSQLString(r *big.Rat) string {
	if r.IsInt() {
		return r.Num().String()
	}
	den := new(big.Int).Set(r.Denom())
	twos, fives := 0, 0
	two, five, rem := big.NewInt(2), big.NewInt(5), new(big.Int)
	for {
		q := new(big.Int)
		q.QuoRem(den, two, rem)
		if rem.Sign() != 0 {
			break
		}
		den = q
		twos++
	}
	for {
		q := new(big.Int)
		q.QuoRem(den, five, rem)
		if rem.Sign() != 0 {
			break
		}
		den = q
		fives++
	}
	if den.Cmp(big.NewInt(1)) == 0 {
		scale := twos
		if fives > scale {
			scale = fives
		}
		return r.FloatString(scale)
	}
	// A non-terminating decimal did not originate from a decimal column.
	// Preserve a useful approximation rather than emitting invalid "a/b" SQL.
	return r.FloatString(38)
}

// boundPredicate builds the lexicographic >= (lower) or < (upper) expression
// for one bound.
func boundPredicate(d Dialect, ph *placeholders, cols []KeyColumn, bound Tuple, lower bool) (string, error) {
	var branches []string
	var prefix []string

	for i, col := range cols {
		current, err := comparisonPredicate(d, ph, col, bound[i], lower, lower && i == len(cols)-1)
		if err != nil {
			return "", err
		}
		if len(prefix) > 0 {
			current = strings.Join(append(append([]string(nil), prefix...), current), " AND ")
		}
		branches = append(branches, "("+current+")")

		if i == len(cols)-1 {
			break
		}
		eq, err := equalityPredicate(d, ph, col, bound[i])
		if err != nil {
			return "", err
		}
		prefix = append(prefix, eq)
	}
	return strings.Join(branches, " OR "), nil
}

func comparisonPredicate(d Dialect, ph *placeholders, col KeyColumn, value Value, lower, inclusive bool) (string, error) {
	name := d.QuoteIdentifier(col.Name)
	if IsNull(value) {
		switch {
		case lower && col.Nulls == NullsFirst:
			if !inclusive {
				return name + " IS NOT NULL", nil
			}
			return "TRUE", nil
		case lower:
			if !inclusive {
				return "FALSE", nil
			}
			return name + " IS NULL", nil
		case col.Nulls == NullsFirst:
			return "FALSE", nil
		default:
			return name + " IS NOT NULL", nil
		}
	}

	op := ">"
	includeNull := col.Nulls == NullsLast
	if lower {
		switch {
		case inclusive && col.Desc:
			op = "<="
		case inclusive:
			op = ">="
		case col.Desc:
			op = "<"
		}
	} else {
		op = "<"
		includeNull = col.Nulls == NullsFirst
		if col.Desc {
			op = ">"
		}
	}

	expr := name
	if col.Collation != nil && col.Collation.Name() != "" {
		expr = d.Collate(expr, col.Collation.Name())
	}
	cmp := expr + " " + op + " " + ph.value(value)
	if includeNull {
		return "(" + cmp + " OR " + name + " IS NULL)", nil
	}
	return cmp, nil
}

func equalityPredicate(d Dialect, ph *placeholders, col KeyColumn, value Value) (string, error) {
	name := d.QuoteIdentifier(col.Name)
	if IsNull(value) {
		return name + " IS NULL", nil
	}
	expr := name
	if col.Collation != nil && col.Collation.Name() != "" {
		expr = d.Collate(expr, col.Collation.Name())
	}
	return expr + " = " + ph.value(value), nil
}
