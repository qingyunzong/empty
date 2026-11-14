package dataeng_test

import (
	"context"
	"fmt"

	dataeng "example.org/dataeng/q0022"
)

func ExampleCoordinator() {
	relation := dataeng.Relation{
		ID:        42,
		Version:   1,
		Namespace: "public",
		Name:      "users",
		Columns: []dataeng.Column{
			{Name: "id", Type: "int8"},
			{Name: "name", Type: "text"},
		},
		PrimaryKey: []string{"id"},
	}
	snapshot := dataeng.Snapshot{
		Database:         "app",
		Slot:             "app_slot",
		ExportedSnapshot: "00000003-0000001B-1",
		ConsistentPoint:  dataeng.MustParseLSN("0/1000"),
		Relations:        []dataeng.Relation{relation},
	}
	snapshotRows := []dataeng.SnapshotRow{
		{RelationID: 42, RelationVersion: 1, Row: dataeng.Row{
			"id":   dataeng.TextValue("1"),
			"name": dataeng.TextValue("alice"),
		}},
	}
	changes := []dataeng.Change{
		{
			LSN:             dataeng.MustParseLSN("0/1100"),
			Kind:            dataeng.ChangeInsert,
			RelationID:      42,
			RelationVersion: 1,
			After: dataeng.Row{
				"id":   dataeng.TextValue("2"),
				"name": dataeng.TextValue("bob"),
			},
		},
	}
	sink := dataeng.NewMemorySink()
	coordinator, err := dataeng.NewCoordinator(dataeng.Config{
		Snapshot:       snapshot,
		Store:          dataeng.NewMemoryStore(),
		SnapshotSource: dataeng.NewStaticSnapshotSource(snapshotRows),
		WALSource:      dataeng.NewStaticWALSource(changes),
		Sink:           sink,
	})
	if err != nil {
		panic(err)
	}
	if err := coordinator.Run(context.Background()); err != nil {
		panic(err)
	}
	fmt.Println(len(sink.Rows()))
	// Output: 2
}
