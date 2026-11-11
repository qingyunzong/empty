package q217_test

import (
	"fmt"

	q217 "example.com/dlks/q217"
)

func ExampleValidateCode() {
	program := &q217.Program{
		RegisterCount: 2,
		BufferSize:    1,
		Instructions: []q217.Instruction{
			{Op: q217.OpConst, Dst: 0, Imm: 0},
			{Op: q217.OpLoad1, Dst: 1, Src1: 0},
			{Op: q217.OpReturn, Src1: 1},
		},
	}
	code, err := q217.EncodeProgram(program)
	if err != nil {
		panic(err)
	}
	certificate, err := q217.ValidateCode(code, program.RegisterCount, program.BufferSize)
	if err != nil {
		panic(err)
	}
	if err := q217.VerifyCodeCertificate(code, program.RegisterCount, program.BufferSize, certificate); err != nil {
		panic(err)
	}
	result, err := q217.ExecuteCode(code, program.RegisterCount, []byte{42})
	if err != nil {
		panic(err)
	}
	fmt.Println(result)
	// Output: 42
}
