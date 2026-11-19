package savepoint_test

import (
	"fmt"

	"example.org/dlks/formal/q10036/savepoint"
)

func ExampleManager() {
	manager := savepoint.NewManager()
	events := []savepoint.Event{
		{Seq: 1, Kind: savepoint.KindEstablish, Name: "outer"},
		{Seq: 2, Kind: savepoint.KindRegister, Record: savepoint.Record{ID: "r1", Kind: savepoint.RecordResource}},
		{Seq: 3, Kind: savepoint.KindEstablish, Name: "inner"},
		{Seq: 4, Kind: savepoint.KindRegister, Record: savepoint.Record{ID: "l1", Kind: savepoint.RecordLock}},
		{Seq: 5, Kind: savepoint.KindRollback, Name: "outer"},
		{Seq: 6, Kind: savepoint.KindRelease, Name: "outer"},
		{Seq: 7, Kind: savepoint.KindRollback, Name: "outer"},
	}

	for _, event := range events {
		result := manager.Apply(event)
		fmt.Printf("seq=%d stack=%v undone=%v err=%v\n",
			result.Seq, result.Stack, result.Undone, result.Err)
	}

	// Output:
	// seq=1 stack=[outer] undone=[] err=<nil>
	// seq=2 stack=[outer] undone=[] err=<nil>
	// seq=3 stack=[outer inner] undone=[] err=<nil>
	// seq=4 stack=[outer inner] undone=[] err=<nil>
	// seq=5 stack=[outer] undone=[{l1 2}] err=<nil>
	// seq=6 stack=[] undone=[] err=<nil>
	// seq=7 stack=[] undone=[] err=savepoint: savepoint stack is empty
}
