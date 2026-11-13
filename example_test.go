package dataeng_test

import (
	"fmt"

	dataeng "example.org/dataeng/q0013"
)

func ExampleMessage() {
	message := dataeng.NewMessage()
	if err := message.Expect("1", 11); err != nil {
		panic(err)
	}

	// Fragments may arrive out of order and may overlap.
	if err := message.AddPartial("1", 6, 5, []byte("world")); err != nil {
		panic(err)
	}
	if err := message.AddPartial("1", 0, 6, []byte("hello ")); err != nil {
		panic(err)
	}

	body, err := message.SectionBytes("1")
	if err != nil {
		panic(err)
	}
	fmt.Println(string(body))
	fmt.Println(message.MessageComplete())

	// Output:
	// hello world
	// true
}
