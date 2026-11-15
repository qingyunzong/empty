package dataeng

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

const (
	usersTable = "users"
	usersGen   = uint64(1)
)

func insertTx(id string, changes ...Change) Transaction {
	return Transaction{ID: id, Changes: changes}
}

func insertChange(id Value, row Image) Change {
	if row == nil {
		row = Image{"id": id}
	}
	return Change{
		Operation:        Insert,
		Table:            usersTable,
		SchemaGeneration: usersGen,
		PrimaryKey:       []string{"id"},
		After:            row,
	}
}

func deleteChange(row Image) Change {
	return Change{
		Operation:        Delete,
		Table:            usersTable,
		SchemaGeneration: usersGen,
		PrimaryKey:       []string{"id"},
		Before:           row,
	}
}

func updateChange(before, after Image) Change {
	return Change{
		Operation:        Update,
		Table:            usersTable,
		SchemaGeneration: usersGen,
		PrimaryKey:       []string{"id"},
		Before:           before,
		After:            after,
	}
}

func applyOK(t *testing.T, engine *Engine, transaction Transaction) Result {
	t.Helper()
	result, err := engine.Apply(transaction)
	if err != nil {
		t.Fatalf("Apply(%q) error: %v", transaction.ID, err)
	}
	return result
}

func TestDeleteInsertBecomesOneMigration(t *testing.T) {
	engine := NewEngine()
	applyOK(t, engine, insertTx("tx-1",
		insertChange(1, Image{"id": 1, "email": "alice@example.com", "name": "Alice"})))

	transaction := insertTx("tx-2",
		deleteChange(Image{"id": 1, "email": "alice@example.com", "name": "Alice"}),
		insertChange(2, Image{"id": 2, "email": "alice@example.com", "name": "Alice"}),
	)
	result := applyOK(t, engine, transaction)

	if len(result.Migrations) != 1 {
		t.Fatalf("got %d migrations, want 1: %+v", len(result.Migrations), result.Migrations)
	}
	migration := result.Migrations[0]
	if !strings.HasPrefix(migration.ID, "mig_") {
		t.Fatalf("migration ID %q does not have the mig_ prefix", migration.ID)
	}
	if migration.TransactionID != "tx-2" || migration.Table != usersTable ||
		migration.SchemaGeneration != usersGen {
		t.Fatalf("unexpected migration metadata: %+v", migration)
	}
	if migration.From.Values[0] != 1 || migration.To.Values[0] != 2 {
		t.Fatalf("unexpected migration keys: %+v", migration)
	}
	if migration.DeleteChange != 0 || migration.InsertChange != 1 {
		t.Fatalf("unexpected change positions: %+v", migration)
	}

	rows := engine.Rows(usersTable, usersGen)
	if len(rows) != 1 || rows[0]["id"] != 2 || rows[0]["name"] != "Alice" {
		t.Fatalf("unexpected rows after migration: %#v", rows)
	}
	if _, found, err := engine.Lookup(usersTable, usersGen, map[string]Value{"id": 1}); err != nil || found {
		t.Fatalf("old key lookup: found=%v err=%v", found, err)
	}
	if row, found, err := engine.Lookup(usersTable, usersGen, map[string]Value{"id": 2}); err != nil || !found || row["email"] != "alice@example.com" {
		t.Fatalf("new key lookup: row=%#v found=%v err=%v", row, found, err)
	}
}

func TestCrossTransactionDeleteInsertIsNotGuessed(t *testing.T) {
	engine := NewEngine()
	applyOK(t, engine, insertTx("tx-1",
		insertChange(1, Image{"id": 1, "email": "same@example.com"})))

	result := applyOK(t, engine, insertTx("tx-2",
		deleteChange(Image{"id": 1, "email": "same@example.com"})))
	if len(result.Migrations) != 0 {
		t.Fatalf("delete alone produced migrations: %+v", result.Migrations)
	}

	result = applyOK(t, engine, insertTx("tx-3",
		insertChange(2, Image{"id": 2, "email": "same@example.com"})))
	if len(result.Migrations) != 0 {
		t.Fatalf("insert in a later transaction produced migrations: %+v", result.Migrations)
	}
	rows := engine.Rows(usersTable, usersGen)
	if len(rows) != 1 || rows[0]["id"] != 2 {
		t.Fatalf("unexpected rows: %#v", rows)
	}
}

func TestInsufficientEvidenceLeavesChangesUnmerged(t *testing.T) {
	t.Run("keys only", func(t *testing.T) {
		engine := NewEngine()
		applyOK(t, engine, insertTx("tx-1", insertChange(1, nil)))

		result := applyOK(t, engine, insertTx("tx-2",
			deleteChange(Image{"id": 1}),
			insertChange(2, nil),
		))
		if len(result.Migrations) != 0 {
			t.Fatalf("key-only images were treated as evidence: %+v", result.Migrations)
		}
	})

	t.Run("different non-key values", func(t *testing.T) {
		engine := NewEngine()
		applyOK(t, engine, insertTx("tx-1",
			insertChange(1, Image{"id": 1, "email": "old@example.com"})))

		result := applyOK(t, engine, insertTx("tx-2",
			deleteChange(Image{"id": 1, "email": "old@example.com"}),
			insertChange(2, Image{"id": 2, "email": "new@example.com"}),
		))
		if len(result.Migrations) != 0 {
			t.Fatalf("mismatched non-key images were treated as evidence: %+v", result.Migrations)
		}
	})

	t.Run("different column sets", func(t *testing.T) {
		engine := NewEngine()
		applyOK(t, engine, insertTx("tx-1",
			insertChange(1, Image{"id": 1, "email": "a@example.com", "name": "A"})))

		result := applyOK(t, engine, insertTx("tx-2",
			deleteChange(Image{"id": 1, "email": "a@example.com", "name": "A"}),
			insertChange(2, Image{"id": 2, "email": "a@example.com"}),
		))
		if len(result.Migrations) != 0 {
			t.Fatalf("incomplete before/after images were treated as evidence: %+v", result.Migrations)
		}
	})
}

func TestAmbiguousPairsAreNotMerged(t *testing.T) {
	engine := NewEngine()
	applyOK(t, engine, insertTx("tx-1",
		insertChange(1, Image{"id": 1, "email": "same@example.com"}),
		insertChange(2, Image{"id": 2, "email": "same@example.com"}),
	))

	result := applyOK(t, engine, insertTx("tx-2",
		deleteChange(Image{"id": 1, "email": "same@example.com"}),
		deleteChange(Image{"id": 2, "email": "same@example.com"}),
		insertChange(3, Image{"id": 3, "email": "same@example.com"}),
		insertChange(4, Image{"id": 4, "email": "same@example.com"}),
	))
	if len(result.Migrations) != 0 {
		t.Fatalf("ambiguous pairing was guessed: %+v", result.Migrations)
	}
}

func TestTwoDistinctPairsInOneTransaction(t *testing.T) {
	engine := NewEngine()
	applyOK(t, engine, insertTx("tx-1",
		insertChange(1, Image{"id": 1, "email": "one@example.com"}),
		insertChange(2, Image{"id": 2, "email": "two@example.com"}),
	))

	result := applyOK(t, engine, insertTx("tx-2",
		deleteChange(Image{"id": 1, "email": "one@example.com"}),
		deleteChange(Image{"id": 2, "email": "two@example.com"}),
		insertChange(10, Image{"id": 10, "email": "one@example.com"}),
		insertChange(20, Image{"id": 20, "email": "two@example.com"}),
	))
	if len(result.Migrations) != 2 {
		t.Fatalf("got %d migrations, want 2: %+v", len(result.Migrations), result.Migrations)
	}
	seen := map[string]bool{}
	for _, migration := range result.Migrations {
		if seen[migration.ID] {
			t.Fatalf("duplicate migration ID %q", migration.ID)
		}
		seen[migration.ID] = true
	}
	if !seen[result.Migrations[0].ID] || result.Migrations[0].From.Values[0] != 1 ||
		result.Migrations[1].From.Values[0] != 2 {
		t.Fatalf("migrations are not ordered by delete change: %+v", result.Migrations)
	}
}

func TestPairingNeverCrossesSchemaGenerations(t *testing.T) {
	engine := NewEngine()
	applyOK(t, engine, insertTx("tx-1",
		insertChange(1, Image{"id": 1, "email": "a@example.com"})))

	transaction := insertTx("tx-2",
		Change{
			Operation:        Delete,
			Table:            usersTable,
			SchemaGeneration: 1,
			PrimaryKey:       []string{"id"},
			Before:           Image{"id": 1, "email": "a@example.com"},
		},
		Change{
			Operation:        Insert,
			Table:            usersTable,
			SchemaGeneration: 2,
			PrimaryKey:       []string{"id"},
			After:            Image{"id": 2, "email": "a@example.com"},
		},
	)
	result := applyOK(t, engine, transaction)
	if len(result.Migrations) != 0 {
		t.Fatalf("pair crossed schema generations: %+v", result.Migrations)
	}
}

func TestUniqueIndexSpansSchemaGenerations(t *testing.T) {
	engine := NewEngine()
	applyOK(t, engine, insertTx("tx-1",
		insertChange(1, Image{"id": 1, "email": "a@example.com"})))

	_, err := engine.Apply(insertTx("tx-2",
		Change{
			Operation:        Insert,
			Table:            usersTable,
			SchemaGeneration: 2,
			PrimaryKey:       []string{"id"},
			After:            Image{"id": 1, "email": "a@example.com"},
		},
	))
	if !errors.Is(err, ErrUniqueViolation) {
		t.Fatalf("cross-generation collision error = %v, want ErrUniqueViolation", err)
	}
	if rows := engine.Rows(usersTable, 2); len(rows) != 0 {
		t.Fatalf("cross-generation collision was applied: %#v", rows)
	}
}

func TestExistingMigrationTargetRejectsWholeTransaction(t *testing.T) {
	engine := NewEngine()
	applyOK(t, engine, insertTx("tx-1",
		insertChange(1, Image{"id": 1, "email": "a@example.com"}),
		insertChange(2, Image{"id": 2, "email": "a@example.com"}),
	))

	_, err := engine.Apply(insertTx("tx-2",
		insertChange(3, Image{"id": 3, "email": "new@example.com"}),
		deleteChange(Image{"id": 1, "email": "a@example.com"}),
		insertChange(2, Image{"id": 2, "email": "a@example.com"}),
	))
	if !errors.Is(err, ErrUniqueViolation) {
		t.Fatalf("got error %v, want ErrUniqueViolation", err)
	}

	rows := engine.Rows(usersTable, usersGen)
	if len(rows) != 2 || rows[0]["id"] != 1 || rows[1]["id"] != 2 {
		t.Fatalf("transaction was not atomic: %#v", rows)
	}
	if _, ok := engine.Result("tx-2"); ok {
		t.Fatal("rejected transaction was cached as successful")
	}
}

func TestDuplicateInsertTargetRejectsTransaction(t *testing.T) {
	engine := NewEngine()
	_, err := engine.Apply(insertTx("tx-1",
		insertChange(1, Image{"id": 1, "email": "a@example.com"}),
		insertChange(1, Image{"id": 1, "email": "b@example.com"}),
	))
	if !errors.Is(err, ErrUniqueViolation) {
		t.Fatalf("got error %v, want ErrUniqueViolation", err)
	}
	if rows := engine.Rows(usersTable, usersGen); len(rows) != 0 {
		t.Fatalf("partially applied transaction: %#v", rows)
	}
}

func TestKeyChangingUpdateIsRejected(t *testing.T) {
	engine := NewEngine()
	applyOK(t, engine, insertTx("tx-1",
		insertChange(1, Image{"id": 1, "email": "a@example.com"})))

	_, err := engine.Apply(insertTx("tx-2",
		updateChange(
			Image{"id": 1, "email": "a@example.com"},
			Image{"id": 2, "email": "a@example.com"},
		)))
	if !errors.Is(err, ErrKeyChangeInUpdate) {
		t.Fatalf("got error %v, want ErrKeyChangeInUpdate", err)
	}
	if row, found, _ := engine.Lookup(usersTable, usersGen, map[string]Value{"id": 1}); !found || row["id"] != 1 {
		t.Fatalf("update rejection changed state: %#v", row)
	}
}

func TestBeforeImageMismatchRejectsTransaction(t *testing.T) {
	engine := NewEngine()
	applyOK(t, engine, insertTx("tx-1",
		insertChange(1, Image{"id": 1, "email": "a@example.com"})))

	_, err := engine.Apply(insertTx("tx-2",
		deleteChange(Image{"id": 1, "email": "wrong@example.com"})))
	if !errors.Is(err, ErrBeforeImageMismatch) {
		t.Fatalf("got error %v, want ErrBeforeImageMismatch", err)
	}
	if rows := engine.Rows(usersTable, usersGen); len(rows) != 1 {
		t.Fatalf("mismatched before image changed state: %#v", rows)
	}
}

func TestReplayReturnsSameMigrationIDWithoutReapplying(t *testing.T) {
	engine := NewEngine()
	applyOK(t, engine, insertTx("tx-1",
		insertChange(1, Image{"id": 1, "email": "a@example.com"})))

	transaction := insertTx("tx-2",
		deleteChange(Image{"id": 1, "email": "a@example.com"}),
		insertChange(2, Image{"id": 2, "email": "a@example.com"}),
	)
	first := applyOK(t, engine, transaction)
	second := applyOK(t, engine, transaction)

	if len(first.Migrations) != 1 || len(second.Migrations) != 1 {
		t.Fatalf("unexpected migration counts: first=%d second=%d",
			len(first.Migrations), len(second.Migrations))
	}
	if first.Migrations[0].ID != second.Migrations[0].ID {
		t.Fatalf("replay changed migration ID: %q != %q",
			first.Migrations[0].ID, second.Migrations[0].ID)
	}
	if rows := engine.Rows(usersTable, usersGen); len(rows) != 1 || rows[0]["id"] != 2 {
		t.Fatalf("replay applied the transaction twice: %#v", rows)
	}

	// Rebuilding state from the same CDC stream must produce the same ID.
	rebuilt := NewEngine()
	applyOK(t, rebuilt, insertTx("tx-1",
		insertChange(1, Image{"id": 1, "email": "a@example.com"})))
	replayed := applyOK(t, rebuilt, transaction)
	if replayed.Migrations[0].ID != first.Migrations[0].ID {
		t.Fatalf("rebuild changed migration ID: %q != %q",
			replayed.Migrations[0].ID, first.Migrations[0].ID)
	}
}

func TestReplayUsesCanonicalNumericIdentity(t *testing.T) {
	first := NewEngine()
	applyOK(t, first, insertTx("tx-1",
		insertChange(1, Image{"id": 1, "email": "a@example.com"})))
	firstResult := applyOK(t, first, insertTx("tx-2",
		deleteChange(Image{"id": 1, "email": "a@example.com"}),
		insertChange(2, Image{"id": 2, "email": "a@example.com"}),
	))

	rebuilt := NewEngine()
	applyOK(t, rebuilt, insertTx("tx-1",
		insertChange(float64(1), Image{"id": float64(1), "email": "a@example.com"})))
	replayed := applyOK(t, rebuilt, insertTx("tx-2",
		deleteChange(Image{"id": float64(1), "email": "a@example.com"}),
		insertChange(int64(2), Image{"id": int64(2), "email": "a@example.com"}),
	))

	if firstResult.Migrations[0].ID != replayed.Migrations[0].ID {
		t.Fatalf("numeric decoding changed migration ID: %q != %q",
			firstResult.Migrations[0].ID, replayed.Migrations[0].ID)
	}
}

func TestTransactionIDReuseWithDifferentContentIsRejected(t *testing.T) {
	engine := NewEngine()
	applyOK(t, engine, insertTx("tx-1",
		insertChange(1, Image{"id": 1, "email": "a@example.com"})))

	_, err := engine.Apply(insertTx("tx-1",
		insertChange(2, Image{"id": 2, "email": "b@example.com"})))
	if !errors.Is(err, ErrTransactionConflict) {
		t.Fatalf("got error %v, want ErrTransactionConflict", err)
	}
	rows := engine.Rows(usersTable, usersGen)
	if len(rows) != 1 || rows[0]["id"] != 1 {
		t.Fatalf("conflicting replay changed state: %#v", rows)
	}
}

func TestRegisteredSchemaDrivesEvidenceAndLookup(t *testing.T) {
	engine := NewEngine()
	if err := engine.RegisterSchema(Schema{
		Table:      usersTable,
		Generation: usersGen,
		PrimaryKey: []string{"id"},
		Columns:    []string{"id", "email", "name"},
	}); err != nil {
		t.Fatalf("RegisterSchema: %v", err)
	}

	applyOK(t, engine, insertTx("tx-1",
		insertChange(1, Image{"id": 1, "email": "a@example.com", "name": "A"})))
	transaction := insertTx("tx-2",
		Change{
			Operation:        Delete,
			Table:            usersTable,
			SchemaGeneration: usersGen,
			Before:           Image{"id": 1, "email": "a@example.com", "name": "A"},
		},
		Change{
			Operation:        Insert,
			Table:            usersTable,
			SchemaGeneration: usersGen,
			After:            Image{"id": 2, "email": "a@example.com", "name": "A"},
		},
	)
	result := applyOK(t, engine, transaction)
	if len(result.Migrations) != 1 {
		t.Fatalf("registered schema did not enable pairing: %+v", result.Migrations)
	}

	if err := engine.RegisterSchema(Schema{
		Table:      usersTable,
		Generation: usersGen,
		PrimaryKey: []string{"email"},
		Columns:    []string{"id", "email", "name"},
	}); !errors.Is(err, ErrInvalidSchema) {
		t.Fatalf("conflicting schema error = %v, want ErrInvalidSchema", err)
	}
}

func TestRegisteredSchemaRequiresCompleteEvidenceColumns(t *testing.T) {
	engine := NewEngine()
	if err := engine.RegisterSchema(Schema{
		Table:      usersTable,
		Generation: usersGen,
		PrimaryKey: []string{"id"},
		Columns:    []string{"id", "email", "name"},
	}); err != nil {
		t.Fatalf("RegisterSchema: %v", err)
	}
	applyOK(t, engine, insertTx("tx-1",
		insertChange(1, Image{"id": 1, "email": "a@example.com", "name": "A"})))

	result := applyOK(t, engine, insertTx("tx-2",
		Change{
			Operation:        Delete,
			Table:            usersTable,
			SchemaGeneration: usersGen,
			Before:           Image{"id": 1, "email": "a@example.com"},
		},
		Change{
			Operation:        Insert,
			Table:            usersTable,
			SchemaGeneration: usersGen,
			After:            Image{"id": 2, "email": "a@example.com"},
		},
	))
	if len(result.Migrations) != 0 {
		t.Fatalf("missing registered evidence column was accepted: %+v", result.Migrations)
	}
}

func TestNonKeyUpdateStillWorks(t *testing.T) {
	engine := NewEngine()
	applyOK(t, engine, insertTx("tx-1",
		insertChange(1, Image{"id": 1, "email": "a@example.com", "name": "A"})))

	result := applyOK(t, engine, insertTx("tx-2",
		updateChange(
			Image{"id": 1, "email": "a@example.com"},
			Image{"id": 1, "email": "b@example.com"},
		)))
	if len(result.Migrations) != 0 {
		t.Fatalf("plain update produced a migration: %+v", result.Migrations)
	}
	row, found, err := engine.Lookup(usersTable, usersGen, map[string]Value{"id": 1})
	if err != nil || !found {
		t.Fatalf("lookup: found=%v err=%v", found, err)
	}
	if row["email"] != "b@example.com" || row["name"] != "A" {
		t.Fatalf("unexpected updated row: %#v", row)
	}
}

func TestEmptyTransactionIDAndMissingSchemaAreRejected(t *testing.T) {
	engine := NewEngine()
	if _, err := engine.Apply(Transaction{ID: ""}); !errors.Is(err, ErrInvalidTransaction) {
		t.Fatalf("empty ID error = %v, want ErrInvalidTransaction", err)
	}
	if _, err := engine.Apply(Transaction{
		ID: "tx-1",
		Changes: []Change{{
			Operation:        Insert,
			Table:            usersTable,
			SchemaGeneration: usersGen,
			After:            Image{"id": 1},
		}},
	}); !errors.Is(err, ErrSchemaNotFound) {
		t.Fatalf("missing schema error = %v, want ErrSchemaNotFound", err)
	}
}

func TestDeleteMissingRowIsRejectedAtomically(t *testing.T) {
	engine := NewEngine()
	applyOK(t, engine, insertTx("tx-1",
		insertChange(1, Image{"id": 1, "email": "a@example.com"})))

	_, err := engine.Apply(insertTx("tx-2",
		insertChange(2, Image{"id": 2, "email": "b@example.com"}),
		deleteChange(Image{"id": 99, "email": "missing@example.com"}),
	))
	if !errors.Is(err, ErrRowNotFound) {
		t.Fatalf("got error %v, want ErrRowNotFound", err)
	}
	rows := engine.Rows(usersTable, usersGen)
	if len(rows) != 1 || rows[0]["id"] != 1 {
		t.Fatalf("missing-row delete was not atomic: %#v", rows)
	}
}

func TestSnapshotRestoreKeepsReplayMigrationID(t *testing.T) {
	engine := NewEngine()
	applyOK(t, engine, insertTx("tx-1",
		insertChange(1, Image{"id": 1, "email": "a@example.com"})))
	transaction := insertTx("tx-2",
		deleteChange(Image{"id": 1, "email": "a@example.com"}),
		insertChange(2, Image{"id": 2, "email": "a@example.com"}),
	)
	original := applyOK(t, engine, transaction)

	encoded, err := json.Marshal(engine.Snapshot())
	if err != nil {
		t.Fatalf("marshal snapshot: %v", err)
	}
	var decoded Snapshot
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal snapshot: %v", err)
	}
	restored, err := NewEngineFromSnapshot(decoded)
	if err != nil {
		t.Fatalf("restore snapshot: %v", err)
	}

	replayed := applyOK(t, restored, transaction)
	if len(replayed.Migrations) != 1 || len(original.Migrations) != 1 {
		t.Fatalf("unexpected migration counts: restored=%d original=%d",
			len(replayed.Migrations), len(original.Migrations))
	}
	if replayed.Migrations[0].ID != original.Migrations[0].ID {
		t.Fatalf("restored replay changed migration ID: %q != %q",
			replayed.Migrations[0].ID, original.Migrations[0].ID)
	}
	rows := restored.Rows(usersTable, usersGen)
	if len(rows) != 1 || rows[0]["id"] != float64(2) {
		t.Fatalf("restored replay changed rows: %#v", rows)
	}
}
