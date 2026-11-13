package dataeng

import (
	"context"
	"errors"
	"testing"
)

var (
	columnA = MustParseOID(".1.3.6.1.2.1.99.1.1")
	columnB = MustParseOID(".1.3.6.1.2.1.99.1.3")
	columnC = MustParseOID(".1.3.6.1.2.1.99.1.5")
)

type bulkCall struct {
	oids           []OID
	nonRepeaters   int
	maxRepetitions int
}

type recordingClient struct {
	calls     []bulkCall
	responses [][]VarBind
	respond   func(call int, oids []OID, nonRepeaters, maxRepetitions int) ([]VarBind, error)
}

func (c *recordingClient) GetBulk(_ context.Context, oids []OID, nonRepeaters, maxRepetitions int) ([]VarBind, error) {
	copied := make([]OID, len(oids))
	for i := range oids {
		copied[i] = oids[i].Clone()
	}
	c.calls = append(c.calls, bulkCall{
		oids:           copied,
		nonRepeaters:   nonRepeaters,
		maxRepetitions: maxRepetitions,
	})
	call := len(c.calls) - 1
	if c.respond != nil {
		return c.respond(call, oids, nonRepeaters, maxRepetitions)
	}
	if call >= len(c.responses) {
		return nil, nil
	}
	return c.responses[call], nil
}

func instance(base OID, index ...uint32) OID {
	oid := base.Clone()
	return append(oid, index...)
}

func value(base OID, index uint32, v any) VarBind {
	return VarBind{OID: instance(base, index), Type: TypeOctetString, Value: v}
}

func endOfMib(base OID, index uint32) VarBind {
	return VarBind{
		OID:   instance(base, index),
		Type:  TypeEndOfMibView,
		Value: EndOfMibView,
	}
}

func TestWalkTableMultiColumnAndSparseAlignment(t *testing.T) {
	client := &recordingClient{responses: [][]VarBind{
		{
			value(columnA, 1, "a1"), value(columnB, 1, "b1"), value(columnC, 1, "c1"),
			value(columnA, 2, "a2"), value(columnB, 3, "b3"), value(columnC, 3, "c3"),
		},
		{
			value(columnA, 3, "a3"), endOfMib(columnB, 4), endOfMib(columnC, 4),
			endOfMib(columnA, 4),
		},
	}}

	table, err := WalkTable(
		context.Background(),
		client,
		[]OID{columnA, columnB, columnC},
		WithMaxRepetitions(2),
	)
	if err != nil {
		t.Fatalf("WalkTable returned error: %v", err)
	}
	if len(client.calls) != 2 {
		t.Fatalf("got %d requests, want 2", len(client.calls))
	}
	if len(table.Rows) != 3 {
		t.Fatalf("got %d rows, want 3", len(table.Rows))
	}

	wantFirst := []OID{columnA, columnB, columnC}
	assertOIDs(t, "first request", client.calls[0].oids, wantFirst)
	assertOIDs(t, "second request", client.calls[1].oids, []OID{
		instance(columnA, 2),
		instance(columnB, 3),
		instance(columnC, 3),
	})
	if client.calls[0].nonRepeaters != 0 {
		t.Fatalf("non-repeaters = %d, want 0", client.calls[0].nonRepeaters)
	}
	if client.calls[0].maxRepetitions != 2 || client.calls[1].maxRepetitions != 2 {
		t.Fatalf("max-repetitions = %d/%d, want 2/2",
			client.calls[0].maxRepetitions, client.calls[1].maxRepetitions)
	}

	if got, _ := table.Rows[0].Value(0); got != "a1" {
		t.Fatalf("row 1 column A = %v, want a1", got)
	}
	if got, _ := table.Rows[1].Value(0); got != "a2" {
		t.Fatalf("row 2 column A = %v, want a2", got)
	}
	if got, _ := table.Rows[1].Value(1); got != nil {
		t.Fatalf("row 2 column B = %v, want nil", got)
	}
	if got, _ := table.Rows[1].Value(2); got != nil {
		t.Fatalf("row 2 column C = %v, want nil", got)
	}
	cell, ok := table.Rows[1].Cell(1)
	if !ok {
		t.Fatal("row 2 column B cell is missing")
	}
	if cell.Present {
		t.Fatal("row 2 column B should be absent")
	}
	if !cell.Column.Equal(columnB) {
		t.Fatalf("absent cell source = %s, want %s", cell.Column, columnB)
	}
	if got, _ := table.Rows[2].Value(0); got != "a3" {
		t.Fatalf("row 3 column A = %v, want a3", got)
	}
	if got, _ := table.Rows[2].Value(1); got != "b3" {
		t.Fatalf("row 3 column B = %v, want b3", got)
	}
	if got, _ := table.Rows[2].Value(2); got != "c3" {
		t.Fatalf("row 3 column C = %v, want c3", got)
	}
}

func TestWalkTableColumnsEndIndependently(t *testing.T) {
	client := &recordingClient{responses: [][]VarBind{
		{
			value(columnA, 1, "a1"),
			value(columnB, 1, "b1"),
			endOfMib(columnA, 2),
			value(columnB, 2, "b2"),
		},
		{
			value(columnB, 3, "b3"),
			endOfMib(columnB, 4),
		},
	}}

	table, err := WalkTable(
		context.Background(),
		client,
		[]OID{columnA, columnB},
		WithMaxRepetitions(2),
	)
	if err != nil {
		t.Fatalf("WalkTable returned error: %v", err)
	}
	if len(client.calls) != 2 {
		t.Fatalf("got %d requests, want 2", len(client.calls))
	}
	assertOIDs(t, "second request", client.calls[1].oids, []OID{instance(columnB, 2)})

	if len(table.Rows) != 3 {
		t.Fatalf("got %d rows, want 3", len(table.Rows))
	}
	if _, present := table.Rows[1].Value(0); present {
		t.Fatal("row 2 column A should be absent after endOfMibView")
	}
	if got, _ := table.Rows[1].Value(1); got != "b2" {
		t.Fatalf("row 2 column B = %v, want b2", got)
	}
	if got, _ := table.Rows[2].Value(1); got != "b3" {
		t.Fatalf("row 3 column B = %v, want b3", got)
	}
}

func TestWalkTableNonIncreasingOIDStopsOnlyThatColumn(t *testing.T) {
	client := &recordingClient{responses: [][]VarBind{
		{
			value(columnA, 2, "a2"),
			value(columnB, 1, "b1"),
			value(columnA, 1, "a1"),
			value(columnB, 2, "b2"),
		},
		{
			value(columnB, 3, "b3"),
			endOfMib(columnB, 4),
		},
	}}

	table, err := WalkTable(
		context.Background(),
		client,
		[]OID{columnA, columnB},
		WithMaxRepetitions(2),
	)
	if err != nil {
		t.Fatalf("WalkTable returned error: %v", err)
	}
	if len(client.calls) != 2 {
		t.Fatalf("got %d requests, want 2", len(client.calls))
	}
	if len(table.Rows) != 3 {
		t.Fatalf("got %d rows, want 3", len(table.Rows))
	}
	if got, _ := table.Rows[1].Value(0); got != "a2" {
		t.Fatalf("row 2 column A = %v, want a2", got)
	}
	if _, present := table.Rows[0].Value(0); present {
		t.Fatal("row 1 column A should be absent after non-increasing OID")
	}
	if got, _ := table.Rows[0].Value(1); got != "b1" {
		t.Fatalf("row 1 column B = %v, want b1", got)
	}
	if got, _ := table.Rows[2].Value(1); got != "b3" {
		t.Fatalf("row 3 column B = %v, want b3", got)
	}
}

func TestWalkTableOutOfBoundsOIDStopsColumn(t *testing.T) {
	outOfBounds := MustParseOID(".1.3.6.1.2.1.99.1.2.5")
	client := &recordingClient{responses: [][]VarBind{
		{
			value(columnA, 1, "a1"),
			value(columnB, 1, "b1"),
			{OID: outOfBounds, Type: TypeOctetString, Value: "stray"},
			value(columnB, 2, "b2"),
		},
		{
			value(columnB, 3, "b3"),
			endOfMib(columnB, 4),
		},
	}}

	table, err := WalkTable(
		context.Background(),
		client,
		[]OID{columnA, columnB},
		WithMaxRepetitions(2),
	)
	if err != nil {
		t.Fatalf("WalkTable returned error: %v", err)
	}
	if len(client.calls) != 2 {
		t.Fatalf("got %d requests, want 2", len(client.calls))
	}
	assertOIDs(t, "second request", client.calls[1].oids, []OID{instance(columnB, 2)})
	if len(table.Rows) != 3 {
		t.Fatalf("got %d rows, want 3", len(table.Rows))
	}
	if row, ok := table.Row(MustParseOID("2")); !ok {
		t.Fatal("row 2 is missing")
	} else if _, present := row.Value(0); present {
		t.Fatal("row 2 column A should be absent")
	}
	if got, _ := table.Rows[2].Value(1); got != "b3" {
		t.Fatalf("row 3 column B = %v, want b3", got)
	}
}

func TestWalkTableOutOfBoundsDoesNotStopNeighbouringColumn(t *testing.T) {
	outOfBounds := MustParseOID(".1.3.6.1.2.1.99.2.1")
	client := &recordingClient{responses: [][]VarBind{
		{
			value(columnA, 1, "a1"),
			value(columnB, 1, "b1"),
			{OID: outOfBounds, Type: TypeOctetString, Value: "stray"},
			value(columnB, 2, "b2"),
		},
		{
			value(columnB, 3, "b3"),
			endOfMib(columnB, 4),
		},
	}}

	table, err := WalkTable(
		context.Background(),
		client,
		[]OID{columnA, columnB},
		WithMaxRepetitions(2),
	)
	if err != nil {
		t.Fatalf("WalkTable returned error: %v", err)
	}
	if len(client.calls) != 2 {
		t.Fatalf("got %d requests, want 2", len(client.calls))
	}
	assertOIDs(t, "second request", client.calls[1].oids, []OID{instance(columnB, 2)})
	if len(table.Rows) != 3 {
		t.Fatalf("got %d rows, want 3", len(table.Rows))
	}
	if got, present := table.Rows[0].Value(1); !present || got != "b1" {
		t.Fatalf("row 1 column B = %v (present %v), want b1", got, present)
	}
	if got, _ := table.Rows[0].Value(0); got != "a1" {
		t.Fatalf("row 1 column A = %v, want a1", got)
	}
	if _, present := table.Rows[2].Value(0); present {
		t.Fatal("row 3 column A should be absent")
	}
	if got, _ := table.Rows[2].Value(1); got != "b3" {
		t.Fatalf("row 3 column B = %v, want b3", got)
	}
}

func TestWalkTableRepeatedResponseIsIdempotent(t *testing.T) {
	client := &recordingClient{
		respond: func(_ int, _ []OID, _, _ int) ([]VarBind, error) {
			return []VarBind{
				value(columnA, 1, "a1"),
				value(columnA, 2, "a2"),
			}, nil
		},
	}

	table, err := WalkTable(context.Background(), client, []OID{columnA}, WithMaxRepetitions(2))
	if err != nil {
		t.Fatalf("WalkTable returned error: %v", err)
	}
	if len(client.calls) != 2 {
		t.Fatalf("got %d requests, want 2", len(client.calls))
	}
	if len(table.Rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(table.Rows))
	}
	if got, _ := table.Rows[0].Value(0); got != "a1" {
		t.Fatalf("row 1 = %v, want a1", got)
	}
	if got, _ := table.Rows[1].Value(0); got != "a2" {
		t.Fatalf("row 2 = %v, want a2", got)
	}
}

func TestWalkTableNonRepeaters(t *testing.T) {
	client := &recordingClient{responses: [][]VarBind{
		{
			value(columnA, 1, "a1"),
			value(columnB, 1, "b1"),
			value(columnB, 2, "b2"),
		},
		{
			value(columnA, 2, "a2"),
			value(columnB, 3, "b3"),
			endOfMib(columnB, 4),
		},
		{
			endOfMib(columnA, 3),
		},
	}}

	table, err := WalkTable(
		context.Background(),
		client,
		[]OID{columnA, columnB},
		WithNonRepeaters(1),
		WithMaxRepetitions(2),
	)
	if err != nil {
		t.Fatalf("WalkTable returned error: %v", err)
	}
	if len(client.calls) != 3 {
		t.Fatalf("got %d requests, want 3", len(client.calls))
	}
	for i, call := range client.calls {
		if call.nonRepeaters != 1 {
			t.Fatalf("request %d non-repeaters = %d, want 1", i, call.nonRepeaters)
		}
		if call.maxRepetitions != 2 {
			t.Fatalf("request %d max-repetitions = %d, want 2", i, call.maxRepetitions)
		}
	}
	assertOIDs(t, "first request", client.calls[0].oids, []OID{columnA, columnB})
	assertOIDs(t, "second request", client.calls[1].oids, []OID{instance(columnA, 1), instance(columnB, 2)})
	assertOIDs(t, "third request", client.calls[2].oids, []OID{instance(columnA, 2)})

	if len(table.Rows) != 3 {
		t.Fatalf("got %d rows, want 3", len(table.Rows))
	}
	if got, _ := table.Rows[0].Value(0); got != "a1" {
		t.Fatalf("row 1 column A = %v, want a1", got)
	}
	if got, _ := table.Rows[1].Value(0); got != "a2" {
		t.Fatalf("row 2 column A = %v, want a2", got)
	}
	if _, present := table.Rows[2].Value(0); present {
		t.Fatal("row 3 column A should be absent")
	}
}

func TestWalkTableReturnsPartialTableOnClientError(t *testing.T) {
	client := &recordingClient{
		respond: func(call int, _ []OID, _, _ int) ([]VarBind, error) {
			if call == 0 {
				return []VarBind{value(columnA, 1, "a1")}, nil
			}
			return nil, errors.New("transport failed")
		},
	}

	table, err := WalkTable(context.Background(), client, []OID{columnA})
	if err == nil {
		t.Fatal("WalkTable returned nil error, want transport error")
	}
	if table == nil {
		t.Fatal("WalkTable returned nil table with partial data")
	}
	if got, _ := table.Rows[0].Value(0); got != "a1" {
		t.Fatalf("partial row = %v, want a1", got)
	}
}

func TestWalkTableRetiresColumnOnEmptyTerminalOID(t *testing.T) {
	client := &recordingClient{responses: [][]VarBind{
		{
			value(columnA, 1, "a1"),
			value(columnB, 1, "b1"),
			{Type: TypeEndOfMibView, Value: EndOfMibView},
			value(columnB, 2, "b2"),
		},
		{
			endOfMib(columnB, 3),
		},
	}}

	table, err := WalkTable(
		context.Background(),
		client,
		[]OID{columnA, columnB},
		WithMaxRepetitions(2),
	)
	if err != nil {
		t.Fatalf("WalkTable returned error: %v", err)
	}
	if len(client.calls) != 2 {
		t.Fatalf("got %d requests, want 2", len(client.calls))
	}
	if _, present := table.Row(mustOID(t, "2")); !present {
		t.Fatal("row 2 is missing")
	}
}

func TestOIDParseCompareAndPrefix(t *testing.T) {
	oid, err := ParseOID(" .1.3.6.1.2.1.99.1.1 ")
	if err != nil {
		t.Fatalf("ParseOID returned error: %v", err)
	}
	if oid.String() != "1.3.6.1.2.1.99.1.1" {
		t.Fatalf("OID string = %q", oid.String())
	}
	if oid.Dotted() != ".1.3.6.1.2.1.99.1.1" {
		t.Fatalf("dotted OID = %q", oid.Dotted())
	}
	if !oid.HasPrefix(MustParseOID("1.3.6.1")) {
		t.Fatal("expected prefix match")
	}
	if MustParseOID("1.3.6.2").Compare(MustParseOID("1.3.6.10")) >= 0 {
		t.Fatal("OID comparison must be numeric, not lexical")
	}
	if _, ok := oid.Suffix(MustParseOID("1.3.6")); !ok {
		t.Fatal("expected suffix")
	}

	for _, input := range []string{"", ".", "1..3", "-1.3", "1.3.4294967296"} {
		if _, err := ParseOID(input); err == nil {
			t.Fatalf("ParseOID(%q) returned nil error", input)
		}
	}
}

func TestWalkTableRejectsInvalidColumnsAndOptions(t *testing.T) {
	client := &recordingClient{}
	if _, err := WalkTable(context.Background(), client, []OID{nil}); !errors.Is(err, ErrInvalidColumn) {
		t.Fatalf("empty column error = %v", err)
	}
	if _, err := WalkTable(context.Background(), client, []OID{columnA, columnA.Clone()}); !errors.Is(err, ErrDuplicateColumn) {
		t.Fatalf("duplicate column error = %v", err)
	}
	if _, err := WalkTable(context.Background(), client, []OID{columnA}, WithMaxRepetitions(-1)); err == nil {
		t.Fatal("negative max-repetitions was accepted")
	}
	if _, err := WalkTable(context.Background(), nil, []OID{columnA}); !errors.Is(err, ErrNilClient) {
		t.Fatalf("nil client error = %v", err)
	}
}

func TestWalkTableMaxRequests(t *testing.T) {
	client := &recordingClient{
		respond: func(_ int, _ []OID, _, _ int) ([]VarBind, error) {
			return []VarBind{value(columnA, 1, "a1")}, nil
		},
	}
	_, err := WalkTable(
		context.Background(),
		client,
		[]OID{columnA},
		WithMaxRepetitions(1),
		WithMaxRequests(1),
	)
	if !errors.Is(err, ErrMaxRequests) {
		t.Fatalf("max requests error = %v", err)
	}
}

func TestWalkTableOutOfBoundsFallbackWhenPositionCannotMap(t *testing.T) {
	outOfBounds := MustParseOID(".1.3.6.1.2.1.99.2.1")
	client := &recordingClient{responses: [][]VarBind{
		{
			value(columnA, 1, "a1"),
			value(columnB, 1, "b1"),
			{OID: outOfBounds, Type: TypeOctetString, Value: "stray"},
		},
		{
			endOfMib(columnA, 2),
		},
	}}

	table, err := WalkTable(
		context.Background(),
		client,
		[]OID{columnA, columnB},
		WithNonRepeaters(2),
		WithMaxRepetitions(2),
	)
	if err != nil {
		t.Fatalf("WalkTable returned error: %v", err)
	}
	if len(client.calls) != 2 {
		t.Fatalf("got %d requests, want 2", len(client.calls))
	}
	assertOIDs(t, "second request", client.calls[1].oids, []OID{instance(columnA, 1)})
	if client.calls[1].nonRepeaters != 1 {
		t.Fatalf("clamped non-repeaters = %d, want 1", client.calls[1].nonRepeaters)
	}
	if len(table.Rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(table.Rows))
	}
	if got, _ := table.Rows[0].Value(0); got != "a1" {
		t.Fatalf("row 1 column A = %v, want a1", got)
	}
	if got, _ := table.Rows[0].Value(1); got != "b1" {
		t.Fatalf("row 1 column B = %v, want b1", got)
	}
}

func TestWalkTableMaxRowsAndColumnValues(t *testing.T) {
	client := &recordingClient{responses: [][]VarBind{
		{
			value(columnA, 1, "a1"), value(columnA, 2, "a2"), value(columnA, 3, "a3"),
		},
	}}

	table, err := WalkTable(
		context.Background(),
		client,
		[]OID{columnA},
		WithMaxRepetitions(3),
		WithMaxRows(2),
	)
	if err != nil {
		t.Fatalf("WalkTable returned error: %v", err)
	}
	if len(table.Rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(table.Rows))
	}
	values := table.ColumnValues(0)
	if len(values) != 2 || values[0] != "a1" || values[1] != "a2" {
		t.Fatalf("column values = %#v, want [a1 a2]", values)
	}
	if table.ColumnValues(2) != nil {
		t.Fatal("out-of-range column should return nil")
	}
}

func assertOIDs(t *testing.T, label string, got, want []OID) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s has %d OIDs, want %d", label, len(got), len(want))
	}
	for i := range want {
		if !got[i].Equal(want[i]) {
			t.Fatalf("%s OID %d = %s, want %s", label, i, got[i], want[i])
		}
	}
}

func mustOID(t *testing.T, value string) OID {
	t.Helper()
	oid, err := ParseOID(value)
	if err != nil {
		t.Fatalf("ParseOID(%q): %v", value, err)
	}
	return oid
}
