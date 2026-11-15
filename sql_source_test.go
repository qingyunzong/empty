package dataeng

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"math/big"
	"strings"
	"sync"
	"testing"
)

func TestSQLSnapshotReadsCountAndSampleInOneTransaction(t *testing.T) {
	conn := &fakeConn{count: 10, sample: [][]driver.Value{{int64(4)}, {int64(8)}}}
	db := sql.OpenDB(&fakeConnector{conn: conn})
	defer db.Close()

	src := &SQLSource{
		DB:      db,
		Dialect: SQLite,
		Catalog: StaticCatalog{
			"items": []KeyColumn{{Name: "id", Kind: KindInt}},
		},
	}
	snap, err := src.BeginSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	plan, err := BuildPlan(context.Background(), snap, "items", Options{ChunkCount: 3})
	if err != nil {
		t.Fatal(err)
	}
	if err := plan.Validate(); err != nil {
		t.Fatal(err)
	}
	if got := len(plan.Chunks); got != 3 {
		t.Fatalf("chunks = %d, want 3", got)
	}
	if got := FormatTuple(plan.Boundaries[0]); got != "(4)" {
		t.Fatalf("first boundary = %s", got)
	}
	if got := FormatTuple(plan.Boundaries[1]); got != "(8)" {
		t.Fatalf("second boundary = %s", got)
	}
	if err := snap.Close(); err != nil {
		t.Fatal(err)
	}

	conn.mu.Lock()
	defer conn.mu.Unlock()
	if conn.begins != 1 {
		t.Fatalf("BeginTx calls = %d, want 1", conn.begins)
	}
	if conn.opts == nil || conn.opts.Isolation != sql.LevelRepeatableRead || !conn.opts.ReadOnly {
		t.Fatalf("transaction options = %+v", conn.opts)
	}
	if conn.tx.rollbacks != 1 {
		t.Fatalf("rollbacks = %d, want 1", conn.tx.rollbacks)
	}
	var sawSample bool
	for _, query := range conn.queries {
		upper := strings.ToUpper(query)
		if strings.Contains(upper, "OFFSET") {
			t.Fatalf("unexpected pagination SQL: %s", query)
		}
		if strings.Contains(upper, "ROW_NUMBER()") {
			sawSample = true
			if !strings.Contains(query, "%") {
				t.Fatalf("sample query has no half-open bucket arithmetic: %s", query)
			}
		}
	}
	if !sawSample {
		t.Fatalf("no sampling query: %v", conn.queries)
	}
	if len(conn.queryArgs) == 0 {
		t.Fatal("sample query had no arguments")
	}
	lastArgs := conn.queryArgs[len(conn.queryArgs)-1]
	if len(lastArgs) != 2 || lastArgs[0].Value != int64(4) || lastArgs[1].Value != int64(2) {
		t.Fatalf("sample args = %v, want [4 2]", lastArgs)
	}
}

func TestSQLSourceRejectsMissingDatabaseAndCatalog(t *testing.T) {
	if _, err := (&SQLSource{}).BeginSnapshot(context.Background()); !errors.Is(err, ErrInvalidPlan) {
		t.Fatalf("nil db error = %v", err)
	}
	db := sql.OpenDB(&fakeConnector{conn: &fakeConn{}})
	defer db.Close()
	if _, err := (&SQLSource{DB: db}).BeginSnapshot(context.Background()); !errors.Is(err, ErrNoPrimaryKey) {
		t.Fatalf("nil catalog error = %v", err)
	}
}

func TestPgTypeKindAndTextNormalization(t *testing.T) {
	cases := map[string]Kind{
		"integer":                  KindInt,
		"bigint":                   KindInt,
		"numeric(12,2)":            KindFloat,
		"character varying(10)":    KindString,
		"bytea":                    KindBytes,
		"timestamp with time zone": KindTime,
		"boolean":                  KindBool,
	}
	for sqlType, want := range cases {
		if got := pgTypeKind(sqlType); got != want {
			t.Fatalf("pgTypeKind(%q) = %s, want %s", sqlType, got, want)
		}
	}
	if !isBinaryCollation("C") || !isBinaryCollation("POSIX") || isBinaryCollation("en_US") {
		t.Fatal("binary collation detection is wrong")
	}
	if v, err := normalizeText("12", KeyColumn{Name: "i", Kind: KindInt}); err != nil || v != int64(12) {
		t.Fatalf("int normalization = %v, %v", v, err)
	}
	if v, err := normalizeText("1.5", KeyColumn{Name: "n", Kind: KindFloat}); err != nil {
		t.Fatal(err)
	} else if s, ok := v.(*big.Rat); !ok || s.RatString() != "3/2" {
		t.Fatalf("decimal normalization = %#v", v)
	}
}

type fakeConnector struct {
	conn *fakeConn
}

func (c *fakeConnector) Connect(context.Context) (driver.Conn, error) { return c.conn, nil }
func (c *fakeConnector) Driver() driver.Driver                        { return fakeDriver{} }

type fakeDriver struct{}

func (fakeDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("not used")
}

type fakeConn struct {
	mu        sync.Mutex
	count     int64
	sample    [][]driver.Value
	begins    int
	opts      *sql.TxOptions
	queries   []string
	queryArgs [][]driver.NamedValue
	tx        *fakeTx
}

func (c *fakeConn) Prepare(string) (driver.Stmt, error) { return nil, errors.New("not supported") }
func (c *fakeConn) Close() error                        { return nil }
func (c *fakeConn) Begin() (driver.Tx, error)           { return c.begin(nil) }

func (c *fakeConn) BeginTx(_ context.Context, opts driver.TxOptions) (driver.Tx, error) {
	sqlOpts := &sql.TxOptions{
		Isolation: sql.IsolationLevel(opts.Isolation),
		ReadOnly:  opts.ReadOnly,
	}
	return c.begin(sqlOpts)
}

func (c *fakeConn) begin(opts *sql.TxOptions) (driver.Tx, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.begins++
	c.opts = opts
	c.tx = &fakeTx{}
	return c.tx, nil
}

func (c *fakeConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.queries = append(c.queries, query)
	c.queryArgs = append(c.queryArgs, append([]driver.NamedValue(nil), args...))
	if strings.HasPrefix(strings.ToUpper(strings.TrimSpace(query)), "SELECT COUNT(*)") {
		return &fakeRows{cols: []string{"count"}, data: [][]driver.Value{{c.count}}}, nil
	}
	return &fakeRows{cols: []string{"id"}, data: c.sample}, nil
}

type fakeTx struct {
	rollbacks int
}

func (t *fakeTx) Commit() error   { return nil }
func (t *fakeTx) Rollback() error { t.rollbacks++; return nil }

type fakeRows struct {
	cols []string
	data [][]driver.Value
	pos  int
}

func (r *fakeRows) Columns() []string { return r.cols }
func (r *fakeRows) Close() error      { return nil }

func (r *fakeRows) Next(dest []driver.Value) error {
	if r.pos >= len(r.data) {
		return io.EOF
	}
	copy(dest, r.data[r.pos])
	r.pos++
	return nil
}
