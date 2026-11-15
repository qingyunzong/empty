package dataeng_test

import (
	"fmt"

	dataeng "example.org/dataeng/q0241"
)

func ExampleMerger() {
	merger := dataeng.NewMerger("shard-a", "shard-b")
	result, err := merger.PushBatch([]dataeng.Event{
		{
			ShardID:       "shard-b",
			ResumeToken:   "b-2",
			ClusterTime:   dataeng.Timestamp{T: 2, I: 0},
			DocumentKey:   `{"_id":2}`,
			OperationType: "insert",
		},
		{
			ShardID:       "shard-a",
			ResumeToken:   "a-1",
			ClusterTime:   dataeng.Timestamp{T: 1, I: 0},
			DocumentKey:   `{"_id":1}`,
			OperationType: "insert",
		},
	})
	if err != nil {
		panic(err)
	}
	events := append(result.Events, merger.Flush().Events...)
	for _, event := range events {
		fmt.Println(event.Sequence, event.ClusterTime, event.ResumeToken)
	}
	// Output:
	// 1 1:0 a-1
	// 2 2:0 b-2
}
