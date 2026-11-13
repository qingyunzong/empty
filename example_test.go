package dataeng_test

import (
	"fmt"

	"example.org/dataeng13/q0031"
)

func ExampleParse() {
	data := []byte{
		0x10, 0x00, 0x10, 0x00, // (0010,0010)
		0x02, 0x00, 0x00, 0x00, // length 2
		'J', 'D',
	}

	ds, err := dataeng.Parse(data)
	if err != nil {
		panic(err)
	}
	for _, elem := range ds.Elements {
		fmt.Println(elem.Tag)
	}

	// Output:
	// (0010,0010)
}
