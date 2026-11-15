package dataeng

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"math/big"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// Queryer is the subset of database/sql used by snapshot catalogues.
type Queryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// Catalog resolves primary-key metadata. All calls run inside the snapshot's
// transaction; implementations must use the supplied Queryer rather than a
// separate connection.
type Catalog interface {
	PrimaryKey(ctx context.Context, q Queryer, table string) ([]KeyColumn, error)
}

// StaticCatalog maps table names to primary-key definitions.
type StaticCatalog map[string][]KeyColumn

func (c StaticCatalog) PrimaryKey(_ context.Context, _ Queryer, table string) ([]KeyColumn, error) {
	cols, ok := c[table]
	if !ok || len(cols) == 0 {
		return nil, ErrNoPrimaryKey
	}
	return append([]KeyColumn(nil), cols...), nil
}

// PostgresCatalog reads primary-key metadata from PostgreSQL's catalogs.
// ResolveCollation must return a comparator for every non-binary collation
// used by a text key column; without it the catalogue returns
// ErrUnsupportedCollation instead of silently ordering by Go bytes.
type PostgresCatalog struct {
	ResolveCollation func(name string) (Collation, error)
}

func (c PostgresCatalog) PrimaryKey(ctx context.Context, q Queryer, table string) ([]KeyColumn, error) {
	const query = `
SELECT a.attname,
       format_type(a.atttypid, NULL),
       COALESCE(col.collname, ''),
       CASE WHEN (i.indoption[k.ord - 1] & 1) = 1 THEN true ELSE false END AS is_desc,
       CASE WHEN (i.indoption[k.ord - 1] & 2) = 2 THEN true ELSE false END AS nulls_first
FROM pg_index i
JOIN pg_class t ON t.oid = i.indrelid
JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
LEFT JOIN pg_collation col ON col.oid = a.attcollation
WHERE i.indisprimary AND t.oid = $1::regclass
ORDER BY k.ord`

	rows, err := q.QueryContext(ctx, query, table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var cols []KeyColumn
	for rows.Next() {
		var (
			name, sqlType, collation string
			desc, nullsFirst         bool
		)
		if err := rows.Scan(&name, &sqlType, &collation, &desc, &nullsFirst); err != nil {
			return nil, err
		}
		col := KeyColumn{
			Name: name,
			Kind: pgTypeKind(sqlType),
			Desc: desc,
		}
		if nullsFirst {
			col.Nulls = NullsFirst
		}
		if collation != "" && !isBinaryCollation(collation) {
			if c.ResolveCollation == nil {
				return nil, fmt.Errorf("%w: %s (column %q)", ErrUnsupportedCollation, collation, name)
			}
			resolved, err := c.ResolveCollation(collation)
			if err != nil {
				return nil, fmt.Errorf("resolve collation %q for column %q: %w",
					collation, name, err)
			}
			if resolved == nil {
				return nil, fmt.Errorf("%w: %s (column %q)", ErrUnsupportedCollation, collation, name)
			}
			col.Collation = resolved
		}
		cols = append(cols, col)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(cols) == 0 {
		return nil, ErrNoPrimaryKey
	}
	return cols, nil
}

func pgTypeKind(sqlType string) Kind {
	base := sqlType
	if i := strings.IndexAny(base, "( "); i >= 0 {
		base = base[:i]
	}
	switch base {
	case "bool", "boolean":
		return KindBool
	case "smallint", "integer", "bigint", "int2", "int4", "int8", "oid":
		return KindInt
	case "real", "double precision", "numeric", "decimal", "float4", "float8":
		return KindFloat
	case "bytea":
		return KindBytes
	case "timestamp", "timestamp without time zone", "timestamp with time zone",
		"timestamptz", "date", "time", "time without time zone",
		"time with time zone", "timetz":
		return KindTime
	default:
		return KindString
	}
}

func isBinaryCollation(name string) bool {
	switch strings.ToLower(name) {
	case "c", "posix", "binary", "c.utf8", "c.utf-8":
		return true
	default:
		return false
	}
}

// SQLSource opens repeatable-read, read-only transactions. Boundary sampling
// and all chunk queries made through the returned SQLSnapshot use that one
// transaction.
type SQLSource struct {
	DB        *sql.DB
	Dialect   Dialect
	Catalog   Catalog
	TxOptions *sql.TxOptions
}

func (s *SQLSource) BeginSnapshot(ctx context.Context) (Snapshot, error) {
	if s == nil || s.DB == nil {
		return nil, fmt.Errorf("%w: nil database", ErrInvalidPlan)
	}
	if s.Catalog == nil {
		return nil, fmt.Errorf("%w: no primary-key catalogue", ErrNoPrimaryKey)
	}
	d := s.Dialect
	if d == nil {
		d = Postgres
	}
	opts := s.TxOptions
	if opts == nil {
		opts = &sql.TxOptions{
			Isolation: sql.LevelRepeatableRead,
			ReadOnly:  true,
		}
	}
	tx, err := s.DB.BeginTx(ctx, opts)
	if err != nil {
		return nil, fmt.Errorf("begin snapshot transaction: %w", err)
	}
	return &SQLSnapshot{tx: tx, dialect: d, catalog: s.Catalog}, nil
}

// SQLSnapshot is a stable snapshot backed by one database transaction.
type SQLSnapshot struct {
	tx      *sql.Tx
	dialect Dialect
	catalog Catalog
	closed  atomic.Bool
}

// Tx exposes the transaction for callers that need to scan full table rows.
// The transaction must not be used after Close.
func (s *SQLSnapshot) Tx() *sql.Tx { return s.tx }

func (s *SQLSnapshot) PrimaryKey(ctx context.Context, table string) ([]KeyColumn, error) {
	if err := s.open(); err != nil {
		return nil, err
	}
	return s.catalog.PrimaryKey(ctx, s.tx, table)
}

func (s *SQLSnapshot) CountRows(ctx context.Context, table string) (int64, error) {
	if err := s.open(); err != nil {
		return 0, err
	}
	query := "SELECT COUNT(*) FROM " + s.dialect.QuoteIdentifier(table)
	var count int64
	if err := s.tx.QueryRowContext(ctx, query).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

func (s *SQLSnapshot) SampleKeys(ctx context.Context, table string, cols []KeyColumn, limit int) ([]Tuple, error) {
	if err := s.open(); err != nil {
		return nil, err
	}
	if limit <= 0 {
		return nil, nil
	}
	if err := ValidateColumns(cols); err != nil {
		return nil, err
	}
	total, err := s.CountRows(ctx, table)
	if err != nil {
		return nil, err
	}
	if total <= 1 {
		return nil, nil
	}
	stride := (total + int64(limit)) / int64(limit+1)
	if stride < 1 {
		stride = 1
	}

	keyList := make([]string, len(cols))
	for i, col := range cols {
		keyList[i] = s.dialect.QuoteIdentifier(col.Name)
	}
	keys := strings.Join(keyList, ", ")
	order := orderBySQL(s.dialect, cols)
	rn := s.dialect.QuoteIdentifier("__dataeng_row_number")
	alias := s.dialect.QuoteIdentifier("__dataeng_sample")
	for _, col := range cols {
		if col.Name == "__dataeng_row_number" {
			return nil, fmt.Errorf("%w: key column name %q is reserved",
				ErrInvalidKey, col.Name)
		}
	}

	var b strings.Builder
	fmt.Fprintf(&b, "SELECT %s FROM (", keys)
	fmt.Fprintf(&b, "SELECT %s, ROW_NUMBER() OVER (ORDER BY %s) AS %s FROM %s",
		keys, order, rn, s.dialect.QuoteIdentifier(table))
	fmt.Fprintf(&b, ") AS %s WHERE (%s %% %s) = 0 ORDER BY %s LIMIT %s",
		alias, rn, s.dialect.Placeholder(1), order, s.dialect.Placeholder(2))

	rows, err := s.tx.QueryContext(ctx, b.String(), stride, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanKeyRows(rows, cols)
}

func (s *SQLSnapshot) Close() error {
	if !s.closed.CompareAndSwap(false, true) {
		return nil
	}
	err := s.tx.Rollback()
	if errors.Is(err, sql.ErrTxDone) {
		return nil
	}
	return err
}

func (s *SQLSnapshot) open() error {
	if s == nil || s.tx == nil {
		return fmt.Errorf("%w: nil SQL snapshot", ErrInvalidPlan)
	}
	if s.closed.Load() {
		return ErrSnapshotClosed
	}
	return nil
}

func scanKeyRows(rows *sql.Rows, cols []KeyColumn) ([]Tuple, error) {
	var out []Tuple
	for rows.Next() {
		raw := make([]any, len(cols))
		dest := make([]any, len(cols))
		for i := range raw {
			dest[i] = &raw[i]
		}
		if err := rows.Scan(dest...); err != nil {
			return nil, err
		}
		key := make(Tuple, len(cols))
		for i, col := range cols {
			v, err := normalizeScanned(raw[i], col)
			if err != nil {
				return nil, fmt.Errorf("column %q: %w", col.Name, err)
			}
			key[i] = v
		}
		out = append(out, key)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func normalizeScanned(v any, col KeyColumn) (Value, error) {
	if v == nil {
		return nil, nil
	}
	switch x := v.(type) {
	case []byte:
		return normalizeText(string(x), col)
	case string:
		return normalizeText(x, col)
	case int64:
		switch col.Kind {
		case KindInt, KindAny, KindFloat, KindUint:
			return x, nil
		case KindString:
			return strconv.FormatInt(x, 10), nil
		default:
			return nil, fmt.Errorf("%w: cannot scan int64 into %s", ErrIncomparable, col.Kind)
		}
	case float64:
		switch col.Kind {
		case KindFloat, KindAny:
			return x, nil
		case KindInt:
			if math.Trunc(x) == x && x >= math.MinInt64 && x <= math.MaxInt64 {
				return int64(x), nil
			}
			return nil, fmt.Errorf("%w: non-integral %v in int column", ErrIncomparable, x)
		default:
			return nil, fmt.Errorf("%w: cannot scan float64 into %s", ErrIncomparable, col.Kind)
		}
	case bool:
		if col.Kind == KindBool || col.Kind == KindAny {
			return x, nil
		}
		return nil, fmt.Errorf("%w: cannot scan bool into %s", ErrIncomparable, col.Kind)
	case time.Time:
		if col.Kind == KindTime || col.Kind == KindAny {
			return x, nil
		}
		return nil, fmt.Errorf("%w: cannot scan time.Time into %s", ErrIncomparable, col.Kind)
	default:
		return v, nil
	}
}

func normalizeText(text string, col KeyColumn) (Value, error) {
	switch col.Kind {
	case KindString, KindAny:
		return text, nil
	case KindBytes:
		return []byte(text), nil
	case KindInt:
		n, err := strconv.ParseInt(text, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrIncomparable, err)
		}
		return n, nil
	case KindUint:
		n, err := strconv.ParseUint(text, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrIncomparable, err)
		}
		return n, nil
	case KindFloat:
		r, ok := new(big.Rat).SetString(text)
		if !ok {
			return nil, fmt.Errorf("%w: %q is not a number", ErrIncomparable, text)
		}
		return r, nil
	case KindBool:
		b, err := strconv.ParseBool(text)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrIncomparable, err)
		}
		return b, nil
	case KindTime:
		return nil, fmt.Errorf("%w: text timestamp %q is not supported; "+
			"configure a driver that scans time.Time", ErrIncomparable, text)
	default:
		return nil, fmt.Errorf("%w: unsupported kind %s", ErrIncomparable, col.Kind)
	}
}

var (
	// ErrUnsupportedCollation is returned when a database collation has no
	// matching Go comparator.
	ErrUnsupportedCollation = errors.New("dataeng: unsupported collation")
)
