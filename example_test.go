package dataeng_test

import (
	"fmt"

	"example.org/dataeng13/q0419"
)

func ExampleValidator() {
	validator, err := dataeng.NewValidator([]dataeng.Interval{
		{Start: []byte("a"), End: []byte("m")},
		{Start: []byte("d"), End: []byte("z")},
	})
	if err != nil {
		panic(err)
	}

	// Worker 0 owns the overlap [d, m].
	if _, err := validator.Accept(0, [][]byte{[]byte("d"), []byte("m")}, false); err != nil {
		panic(err)
	}

	// Worker 1 must skip the overlap and can finish at its own end.
	status, err := validator.Accept(1, [][]byte{[]byte("n"), []byte("z")}, false)
	if err != nil {
		panic(err)
	}

	fmt.Println(validator.Status(0))
	fmt.Println(status)
	// Output:
	// complete true
	// complete
}
