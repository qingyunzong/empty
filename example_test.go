package dataeng

import "fmt"

func ExampleManager() {
	m := NewManager()

	// Small files land in the table through ordinary manifest appends.
	if _, err := m.Append(
		DataFile{Path: "p/a.parquet", Partition: "p", SizeInBytes: 10, RecordCount: 4},
		DataFile{Path: "p/b.parquet", Partition: "p", SizeInBytes: 12, RecordCount: 5},
		DataFile{Path: "p/c.parquet", Partition: "p", SizeInBytes: 8, RecordCount: 3},
	); err != nil {
		panic(err)
	}

	// Plan a compaction: inputs are selected and claimed for this plan.
	plan, err := m.PlanCompaction("p", PlanOptions{PlanID: "job-1"})
	if err != nil {
		panic(err)
	}
	fmt.Printf("planned %d inputs against snapshot %d\n",
		len(plan.Replacement.Inputs), plan.BaseSnapshotID)

	// The physical job produces an output file, then the replacement commits.
	output := DataFile{Path: "p/compacted.parquet", Partition: "p", SizeInBytes: 30, RecordCount: 12}
	result, err := m.Commit(plan.ID, []DataFile{output})
	if err != nil {
		panic(err)
	}
	fmt.Printf("committed snapshot %d with %d active file(s)\n",
		result.SnapshotID, len(m.Manifest().Files))

	// Replaced inputs are now safe to recycle after snapshot expiration.
	for _, item := range m.RecycleList() {
		fmt.Printf("recycle: %s (%s, immediate=%t)\n", item.Path, item.Reason, item.Immediately)
	}

	// Output:
	// planned 3 inputs against snapshot 1
	// committed snapshot 2 with 1 active file(s)
	// recycle: p/a.parquet (replaced-input, immediate=false)
	// recycle: p/b.parquet (replaced-input, immediate=false)
	// recycle: p/c.parquet (replaced-input, immediate=false)
}
