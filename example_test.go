package dataeng_test

import (
	"fmt"

	dataeng "example.org/dataeng/q0324"
)

func ExampleFormat() {
	// Raw IEEE 754 binary64 bits for 0.1, as received from an exchange field.
	bits := uint64(0x3fb999999999999a)
	result := dataeng.Format(bits)
	sign, coefficient, exponent := result.Tuple()

	fmt.Printf("text=%s\n", result.Text)
	fmt.Printf("tuple=%d %s %d\n", sign, coefficient, exponent)
	fmt.Printf("round_trip=%t\n", result.RoundTrip)
	fmt.Printf("verify=%v\n", dataeng.Verify(result))

	// Output:
	// text=1e-1
	// tuple=1 1 -1
	// round_trip=true
	// verify=<nil>
}
