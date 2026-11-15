package dataeng

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"strings"
)

var captureInstancePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// Querier is the subset of *sql.DB and *sql.Tx needed by SQLReader.
type Querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// SQLReader reads change rows directly from SQL Server CDC change functions.
// It does not depend on a particular SQL driver; *sql.DB works as-is.
type SQLReader struct {
	DB              Querier
	CaptureInstance string
}

// NewSQLReader validates the capture instance name and constructs a reader.
func NewSQLReader(db Querier, captureInstance string) (*SQLReader, error) {
	if db == nil {
		return nil, fmt.Errorf("sqlserver cdc: nil database")
	}
	if !captureInstancePattern.MatchString(captureInstance) {
		return nil, fmt.Errorf("sqlserver cdc: invalid capture instance %q", captureInstance)
	}
	return &SQLReader{DB: db, CaptureInstance: captureInstance}, nil
}

// ReadBounds returns sys.fn_cdc_get_min_lsn and sys.fn_cdc_get_max_lsn for the
// capture instance.
func (r *SQLReader) ReadBounds(ctx context.Context) (Bounds, error) {
	if err := r.validate(); err != nil {
		return Bounds{}, err
	}
	rows, err := r.DB.QueryContext(ctx,
		"SELECT sys.fn_cdc_get_min_lsn(@p1) AS min_lsn, sys.fn_cdc_get_max_lsn() AS max_lsn",
		r.CaptureInstance,
	)
	if err != nil {
		return Bounds{}, fmt.Errorf("sqlserver cdc: read LSN bounds: %w", err)
	}
	defer rows.Close()

	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return Bounds{}, fmt.Errorf("sqlserver cdc: read LSN bounds: %w", err)
		}
		return Bounds{}, nil
	}
	var minValue, maxValue any
	if err := rows.Scan(&minValue, &maxValue); err != nil {
		return Bounds{}, fmt.Errorf("sqlserver cdc: scan LSN bounds: %w", err)
	}
	minLSN, err := lsnFromValue(minValue)
	if err != nil {
		return Bounds{}, fmt.Errorf("sqlserver cdc: min_lsn: %w", err)
	}
	maxLSN, err := lsnFromValue(maxValue)
	if err != nil {
		return Bounds{}, fmt.Errorf("sqlserver cdc: max_lsn: %w", err)
	}
	return Bounds{MinLSN: minLSN, MaxLSN: maxLSN}, nil
}

// Bounds is an alias for ReadBounds.
func (r *SQLReader) Bounds(ctx context.Context) (Bounds, error) {
	return r.ReadBounds(ctx)
}

// ReadChanges reads the closed LSN interval with the 'all update old' row
// filter. That filter is required to receive both operation-3 and
// operation-4 rows for updates.
func (r *SQLReader) ReadChanges(ctx context.Context, from, to LSN) ([]ChangeRow, error) {
	if err := r.validate(); err != nil {
		return nil, err
	}
	if from.IsZero() || to.IsZero() {
		return nil, fmt.Errorf("%w: empty query endpoint", ErrInvalidLSN)
	}
	if CompareLSN(from, to) > 0 {
		return nil, fmt.Errorf("%w: from_lsn %s is after to_lsn %s", ErrInvalidLSN, from, to)
	}
	query := fmt.Sprintf(
		"SELECT * FROM cdc.fn_cdc_get_all_changes_%s(@p1, @p2, N'all update old')",
		r.CaptureInstance,
	)
	rows, err := r.DB.QueryContext(ctx, query, from.Bytes(), to.Bytes())
	if err != nil {
		return nil, fmt.Errorf("sqlserver cdc: read changes [%s, %s]: %w", from, to, err)
	}
	defer rows.Close()

	columns, err := rows.Columns()
	if err != nil {
		return nil, fmt.Errorf("sqlserver cdc: change columns: %w", err)
	}
	values := make([]any, len(columns))
	destinations := make([]any, len(columns))
	for index := range values {
		destinations[index] = &values[index]
	}

	var changes []ChangeRow
	for rows.Next() {
		if err := rows.Scan(destinations...); err != nil {
			return nil, fmt.Errorf("sqlserver cdc: scan change row: %w", err)
		}
		row, err := parseChangeRow(columns, values)
		if err != nil {
			return nil, err
		}
		changes = append(changes, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sqlserver cdc: read changes: %w", err)
	}
	return changes, nil
}

func (r *SQLReader) validate() error {
	if r == nil || r.DB == nil {
		return fmt.Errorf("sqlserver cdc: nil database")
	}
	if !captureInstancePattern.MatchString(r.CaptureInstance) {
		return fmt.Errorf("sqlserver cdc: invalid capture instance %q", r.CaptureInstance)
	}
	return nil
}

// Changes is an alias for ReadChanges.
func (r *SQLReader) Changes(ctx context.Context, from, to LSN) ([]ChangeRow, error) {
	return r.ReadChanges(ctx, from, to)
}

// Batch is the result of a single CDC poll.
type Batch struct {
	Plan    Plan
	Bounds  Bounds
	Rows    []ChangeRow
	Changes []Change
}

// ReadBatch plans the next interval, reads it, and combines before/after
// update images. Snapshot and gap conditions are returned as errors while the
// corresponding Plan is still populated.
func (r *SQLReader) ReadBatch(ctx context.Context, state State, columnOrder []string) (Batch, error) {
	bounds, err := r.ReadBounds(ctx)
	if err != nil {
		return Batch{}, err
	}
	plan, planErr := PlanNext(state, bounds)
	batch := Batch{Plan: plan, Bounds: bounds}
	if planErr != nil {
		return batch, planErr
	}
	if plan.Action != ActionQuery {
		return batch, nil
	}
	rows, err := r.ReadChanges(ctx, plan.Range.FromLSN, plan.Range.ToLSN)
	if err != nil {
		return batch, err
	}
	changes, err := CombineChangesWithColumns(rows, columnOrder)
	if err != nil {
		return batch, err
	}
	changes = FilterChangesAfter(changes, state.Position)
	batch.Rows = rows
	batch.Changes = changes
	return batch, nil
}

func parseChangeRow(columns []string, values []any) (ChangeRow, error) {
	row := ChangeRow{Values: make(map[string]any)}
	for index, name := range columns {
		normalized := strings.ToLower(name)
		value := values[index]
		switch normalized {
		case "__$start_lsn":
			lsn, err := lsnFromValue(value)
			if err != nil {
				return ChangeRow{}, fmt.Errorf("sqlserver cdc: __$start_lsn: %w", err)
			}
			row.StartLSN = lsn
		case "__$seqval":
			lsn, err := lsnFromValue(value)
			if err != nil {
				return ChangeRow{}, fmt.Errorf("sqlserver cdc: __$seqval: %w", err)
			}
			row.SeqVal = lsn
		case "__$operation":
			operation, err := operationFromValue(value)
			if err != nil {
				return ChangeRow{}, err
			}
			row.Operation = operation
		case "__$update_mask":
			mask, _ := valueBytes(value)
			row.UpdateMask = append([]byte(nil), mask...)
		default:
			if strings.HasPrefix(normalized, "__$") {
				continue
			}
			row.Values[name] = value
		}
	}
	if row.StartLSN.IsZero() {
		return ChangeRow{}, fmt.Errorf("%w: change row has no __$start_lsn", ErrInvalidLSN)
	}
	row.Row = row.Values
	return row, nil
}

func operationFromValue(value any) (Operation, error) {
	switch typed := value.(type) {
	case int64:
		return Operation(typed), nil
	case int32:
		return Operation(typed), nil
	case int:
		return Operation(typed), nil
	case []byte:
		var parsed int
		if _, err := fmt.Sscanf(string(typed), "%d", &parsed); err != nil {
			return 0, fmt.Errorf("sqlserver cdc: __$operation %q: %w", typed, err)
		}
		return Operation(parsed), nil
	case string:
		var parsed int
		if _, err := fmt.Sscanf(typed, "%d", &parsed); err != nil {
			return 0, fmt.Errorf("sqlserver cdc: __$operation %q: %w", typed, err)
		}
		return Operation(parsed), nil
	default:
		return 0, fmt.Errorf("%w: __$operation has type %T", ErrUnknownOperation, value)
	}
}

func lsnFromValue(value any) (LSN, error) {
	if value == nil {
		return nil, nil
	}
	raw, ok := valueBytes(value)
	if !ok {
		return nil, fmt.Errorf("%w: cannot convert %T", ErrInvalidLSN, value)
	}
	if len(raw) == LSNLen {
		return LSN(append([]byte(nil), raw...)), nil
	}
	text := strings.TrimSpace(string(raw))
	if strings.Contains(text, ":") || strings.HasPrefix(strings.ToLower(text), "0x") || len(text) == 2*LSNLen {
		return ParseLSN(text)
	}
	return LSN(append([]byte(nil), raw...)), nil
}

func valueBytes(value any) ([]byte, bool) {
	switch typed := value.(type) {
	case []byte:
		return typed, true
	case string:
		return []byte(typed), true
	default:
		return nil, false
	}
}
