package dataeng

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func TestNewSQLReaderValidation(t *testing.T) {
	t.Parallel()

	var nilQuerier Querier
	if _, err := NewSQLReader(nilQuerier, "dbo_customers"); err == nil {
		t.Fatal("NewSQLReader(nil) succeeded")
	}
	if _, err := NewSQLReader(nilQuerier, ""); err == nil {
		t.Fatal("NewSQLReader(nil, invalid) succeeded")
	}
}

func TestParseChangeRow(t *testing.T) {
	t.Parallel()

	columns := []string{
		"__$start_lsn", "__$end_lsn", "__$seqval", "__$operation",
		"__$update_mask", "__$command_id", "id", "name",
	}
	values := []any{
		[]byte{0, 0, 0, 0x2a, 0, 0, 0, 0x5c, 0, 3},
		nil,
		[]byte{0, 0, 0, 0x2a, 0, 0, 0, 0x5c, 0, 3},
		int64(4),
		[]byte{0x01},
		int64(1),
		int64(7),
		"new",
	}
	row, err := parseChangeRow(columns, values)
	if err != nil {
		t.Fatalf("parseChangeRow() error = %v", err)
	}
	if row.Operation != OperationUpdateAfter {
		t.Fatalf("Operation = %d", row.Operation)
	}
	if !reflect.DeepEqual(row.UpdateMask, []byte{0x01}) {
		t.Fatalf("UpdateMask = %x", row.UpdateMask)
	}
	wantValues := map[string]any{"id": int64(7), "name": "new"}
	if !reflect.DeepEqual(row.ClientValues(), wantValues) {
		t.Fatalf("Values = %#v", row.ClientValues())
	}
}

func TestParseChangeRowRequiresStartLSN(t *testing.T) {
	t.Parallel()

	_, err := parseChangeRow([]string{"id"}, []any{int64(1)})
	if !errors.Is(err, ErrInvalidLSN) {
		t.Fatalf("parseChangeRow() error = %v", err)
	}
}

func TestLSNFromTextValue(t *testing.T) {
	t.Parallel()

	got, err := lsnFromValue("0000002a:0000005c:0003")
	if err != nil {
		t.Fatalf("lsnFromValue() error = %v", err)
	}
	if got.String() != "0000002a:0000005c:0003" {
		t.Fatalf("lsnFromValue() = %s", got)
	}
}

func TestSQLReaderReadBatch(t *testing.T) {
	t.Parallel()

	registerFakeDriver()
	db, err := sql.Open("dataeng-fake-cdc", "")
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	defer db.Close()

	reader, err := NewSQLReader(db, "dbo_customers")
	if err != nil {
		t.Fatalf("NewSQLReader() error = %v", err)
	}
	watermark := MustParseLSN("0000002a:0000005c:0001")
	batch, err := reader.ReadBatch(context.Background(), State{Watermark: watermark}, []string{"id", "name"})
	if err != nil {
		t.Fatalf("ReadBatch() error = %v", err)
	}
	if batch.Plan.Action != ActionQuery {
		t.Fatalf("Action = %s", batch.Plan.Action)
	}
	if got := batch.Plan.Range.FromLSN.String(); got != "0000002a:0000005c:0002" {
		t.Fatalf("FromLSN = %s", got)
	}
	if len(batch.Changes) != 1 {
		t.Fatalf("len(Changes) = %d", len(batch.Changes))
	}
	change := batch.Changes[0]
	if change.Kind != KindUpdate || change.Before["name"] != "old" || change.After["name"] != "new" {
		t.Fatalf("change = %#v", change)
	}
	if !reflect.DeepEqual(change.ChangedColumns, []string{"id", "name"}) {
		t.Fatalf("ChangedColumns = %#v", change.ChangedColumns)
	}
}

var registerFakeOnce sync.Once

func registerFakeDriver() {
	registerFakeOnce.Do(func() {
		sql.Register("dataeng-fake-cdc", fakeDriver{})
	})
}

type fakeDriver struct{}

func (fakeDriver) Open(string) (driver.Conn, error) {
	return fakeConn{}, nil
}

type fakeConn struct{}

func (fakeConn) Prepare(query string) (driver.Stmt, error) {
	return fakeStmt{query: query}, nil
}

func (fakeConn) Close() error              { return nil }
func (fakeConn) Begin() (driver.Tx, error) { return nil, errors.New("not supported") }

type fakeStmt struct {
	query string
}

func (fakeStmt) Close() error  { return nil }
func (fakeStmt) NumInput() int { return -1 }

func (fakeStmt) Exec([]driver.Value) (driver.Result, error) {
	return nil, errors.New("not supported")
}

func (s fakeStmt) Query([]driver.Value) (driver.Rows, error) {
	switch {
	case strings.Contains(s.query, "fn_cdc_get_min_lsn"):
		return &fakeRows{
			columns: []string{"min_lsn", "max_lsn"},
			values: [][]driver.Value{{
				[]byte{0, 0, 0, 0x2a, 0, 0, 0, 0x5c, 0, 1},
				[]byte{0, 0, 0, 0x2a, 0, 0, 0, 0x5c, 0, 5},
			}},
		}, nil
	case strings.Contains(s.query, "fn_cdc_get_all_changes_dbo_customers"):
		return &fakeRows{
			columns: []string{
				"__$start_lsn", "__$seqval", "__$operation", "__$update_mask",
				"id", "name",
			},
			values: [][]driver.Value{
				{[]byte{0, 0, 0, 0x2a, 0, 0, 0, 0x5c, 0, 2}, []byte{0, 0, 0, 0x2a, 0, 0, 0, 0x5c, 0, 2}, int64(3), []byte{0x03}, int64(1), "old"},
				{[]byte{0, 0, 0, 0x2a, 0, 0, 0, 0x5c, 0, 2}, []byte{0, 0, 0, 0x2a, 0, 0, 0, 0x5c, 0, 2}, int64(4), []byte{0x03}, int64(1), "new"},
			},
		}, nil
	default:
		return nil, errors.New("unexpected query: " + s.query)
	}
}

type fakeRows struct {
	columns []string
	values  [][]driver.Value
	index   int
}

func (r *fakeRows) Columns() []string { return r.columns }
func (r *fakeRows) Close() error      { return nil }

func (r *fakeRows) Next(dest []driver.Value) error {
	if r.index >= len(r.values) {
		return io.EOF
	}
	copy(dest, r.values[r.index])
	r.index++
	return nil
}
