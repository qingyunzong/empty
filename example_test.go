package dataeng_test

import (
	"testing"

	dataeng "example.org/dataeng/q0162"
)

func TestImportedPackageUsage(t *testing.T) {
	records := []dataeng.Record{
		dataeng.Put("k", 10, []byte("v10")),
		dataeng.Delete("k", 8),
		dataeng.Put("k", 6, []byte("v6")),
	}

	retained, err := dataeng.Compact(records, []dataeng.Snapshot{6, 8, 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(retained) != 3 {
		t.Fatalf("retained %#v", retained)
	}

	indices, err := dataeng.KeepIndices(records, []dataeng.Snapshot{6, 8})
	if err != nil {
		t.Fatal(err)
	}
	if len(indices) != 2 || indices[0] != 1 || indices[1] != 2 {
		t.Fatalf("indices %v", indices)
	}
}
