package q217

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"testing"
)

func constInstruction(dst uint8, value int64) Instruction {
	return Instruction{Op: OpConst, Dst: dst, Imm: value}
}

func addInstruction(dst, left, right uint8) Instruction {
	return Instruction{Op: OpAdd, Dst: dst, Src1: left, Src2: right}
}

func compareInstruction(left, right uint8, operator uint8, target uint16) Instruction {
	return Instruction{Op: OpCmp, Src1: left, Src2: right, Imm: int64(operator), Target: target}
}

func load1Instruction(dst, offset uint8) Instruction {
	return Instruction{Op: OpLoad1, Dst: dst, Src1: offset}
}

func load4Instruction(dst, offset uint8) Instruction {
	return Instruction{Op: OpLoad4, Dst: dst, Src1: offset}
}

func returnInstruction(src uint8) Instruction {
	return Instruction{Op: OpReturn, Src1: src}
}

func encodeForTest(t *testing.T, program *Program) []byte {
	t.Helper()
	code, err := EncodeProgram(program)
	if err != nil {
		t.Fatalf("EncodeProgram: %v", err)
	}
	return code
}

func mustValidate(t *testing.T, program *Program) *Certificate {
	t.Helper()
	certificate, err := ValidateProgram(program)
	if err != nil {
		t.Fatalf("ValidateProgram: %v", err)
	}
	return certificate
}

func TestEncodeDecodeRoundTrip(t *testing.T) {
	program := &Program{
		RegisterCount: 3,
		BufferSize:    4,
		Instructions: []Instruction{
			constInstruction(0, math.MinInt64),
			addInstruction(2, 0, 1),
			load4Instruction(1, 2),
			returnInstruction(1),
		},
	}
	code := encodeForTest(t, program)
	decoded, err := DecodeCode(code)
	if err != nil {
		t.Fatalf("DecodeCode: %v", err)
	}
	if len(decoded) != len(program.Instructions) {
		t.Fatalf("decoded %d instructions, want %d", len(decoded), len(program.Instructions))
	}
	for pc := range program.Instructions {
		if decoded[pc] != program.Instructions[pc] {
			t.Fatalf("instruction %d = %+v, want %+v", pc, decoded[pc], program.Instructions[pc])
		}
	}
}

func TestValidateRejectsUninitializedRegister(t *testing.T) {
	program := &Program{
		RegisterCount: 2,
		BufferSize:    1,
		Instructions: []Instruction{
			load1Instruction(1, 0),
			returnInstruction(1),
		},
	}
	_, err := ValidateProgram(program)
	if !errors.Is(err, ErrUninitializedRegister) {
		t.Fatalf("error = %v, want ErrUninitializedRegister", err)
	}
}

func TestValidateRejectsUnsafeReadAndOverflow(t *testing.T) {
	unsafe := &Program{
		RegisterCount: 2,
		BufferSize:    1,
		Instructions: []Instruction{
			constInstruction(0, 1),
			load1Instruction(1, 0),
			returnInstruction(1),
		},
	}
	if _, err := ValidateProgram(unsafe); !errors.Is(err, ErrUnsafeRead) {
		t.Fatalf("unsafe read error = %v, want ErrUnsafeRead", err)
	}

	load4AtOffsetOne := &Program{
		RegisterCount: 2,
		BufferSize:    4,
		Instructions: []Instruction{
			constInstruction(0, 1),
			load4Instruction(1, 0),
			returnInstruction(1),
		},
	}
	if _, err := ValidateProgram(load4AtOffsetOne); !errors.Is(err, ErrUnsafeRead) {
		t.Fatalf("load4 boundary error = %v, want ErrUnsafeRead", err)
	}

	zeroBufferRead := &Program{
		RegisterCount: 2,
		BufferSize:    0,
		Instructions: []Instruction{
			constInstruction(0, 0),
			load1Instruction(1, 0),
			returnInstruction(1),
		},
	}
	if _, err := ValidateProgram(zeroBufferRead); !errors.Is(err, ErrUnsafeRead) {
		t.Fatalf("zero buffer read error = %v, want ErrUnsafeRead", err)
	}

	overflow := &Program{
		RegisterCount: 3,
		BufferSize:    1,
		Instructions: []Instruction{
			constInstruction(0, math.MaxInt64),
			constInstruction(1, 1),
			addInstruction(2, 0, 1),
			returnInstruction(2),
		},
	}
	if _, err := ValidateProgram(overflow); !errors.Is(err, ErrOverflow) {
		t.Fatalf("overflow error = %v, want ErrOverflow", err)
	}
}

func TestNotEqualFalseEdgeRemainsFeasibleForRanges(t *testing.T) {
	program := &Program{
		RegisterCount: 4,
		BufferSize:    1,
		Instructions: []Instruction{
			constInstruction(0, 0),
			load1Instruction(1, 0),
			constInstruction(2, 0),
			compareInstruction(1, 2, CmpNe, 6),
			constInstruction(3, 0),
			returnInstruction(3),
			load1Instruction(3, 1),
			returnInstruction(3),
		},
	}
	if _, err := ValidateProgram(program); !errors.Is(err, ErrUnsafeRead) {
		t.Fatalf("error = %v, want ErrUnsafeRead on feasible NE false edge", err)
	}
}

func TestImpossibleBranchAndExhaustiveLoad1(t *testing.T) {
	program := &Program{
		RegisterCount: 4,
		BufferSize:    1,
		Instructions: []Instruction{
			constInstruction(0, 0),
			constInstruction(1, 1),
			compareInstruction(0, 1, CmpGt, 6),
			load1Instruction(2, 0),
			returnInstruction(2),
			load1Instruction(3, 0),
			returnInstruction(3),
		},
	}
	certificate := mustValidate(t, program)
	if certificate.Points[6].Reachable {
		t.Fatal("impossible branch target is marked reachable")
	}
	if len(certificate.Reads) != 1 || certificate.Reads[0].PC != 3 {
		t.Fatalf("reads = %+v, want only safe read at pc 3", certificate.Reads)
	}

	code := encodeForTest(t, program)
	for value := 0; value <= math.MaxUint8; value++ {
		result, err := ExecuteCode(code, program.RegisterCount, []byte{byte(value)})
		if err != nil {
			t.Fatalf("value %d: ExecuteCode: %v", value, err)
		}
		if result != int64(value) {
			t.Fatalf("value %d: result = %d", value, result)
		}
	}
}

func TestJoinEnvelopePrecisionAndExhaustiveLoad1(t *testing.T) {
	program := &Program{
		RegisterCount: 5,
		BufferSize:    2,
		Instructions: []Instruction{
			constInstruction(0, 0),
			load1Instruction(1, 0),
			constInstruction(2, 100),
			compareInstruction(1, 2, CmpLt, 7),
			constInstruction(3, 0),
			compareInstruction(3, 3, CmpEq, 8),
			returnInstruction(3),
			constInstruction(3, 1),
			load1Instruction(4, 3),
			returnInstruction(4),
		},
	}
	certificate := mustValidate(t, program)
	joined := certificate.Points[8]
	if !joined.Reachable || !joined.Registers[3].Initialized {
		t.Fatalf("join state = %+v", joined)
	}
	if got := joined.Registers[3].Interval; got != (Interval{Min: 0, Max: 1}) {
		t.Fatalf("joined offset interval = %+v, want envelope [0,1]", got)
	}
	if len(certificate.Reads) != 2 || certificate.Reads[1].Offset != (Interval{Min: 0, Max: 1}) {
		t.Fatalf("read certificates = %+v", certificate.Reads)
	}

	code := encodeForTest(t, program)
	for first := 0; first <= math.MaxUint8; first++ {
		for second := 0; second <= math.MaxUint8; second++ {
			buffer := []byte{byte(first), byte(second)}
			if _, err := ExecuteCode(code, program.RegisterCount, buffer); err != nil {
				t.Fatalf("buffer %v: ExecuteCode: %v", buffer, err)
			}
		}
	}
}

func TestLoad4BoundsAndBoundaryValues(t *testing.T) {
	program := &Program{
		RegisterCount: 4,
		BufferSize:    4,
		Instructions: []Instruction{
			constInstruction(0, 0),
			load4Instruction(1, 0),
			constInstruction(2, math.MinInt32),
			compareInstruction(1, 2, CmpLt, 5),
			returnInstruction(1),
			returnInstruction(1),
		},
	}
	certificate := mustValidate(t, program)
	if len(certificate.Reads) != 1 {
		t.Fatalf("reads = %+v", certificate.Reads)
	}
	if got := certificate.Reads[0].Offset; got != (Interval{Min: 0, Max: 0}) {
		t.Fatalf("offset = %+v, want [0,0]", got)
	}

	code := encodeForTest(t, program)
	for _, value := range []int32{math.MinInt32, -1, 0, 1, math.MaxInt32} {
		buffer := []byte{0, 0, 0, 0}
		binary.LittleEndian.PutUint32(buffer, uint32(value))
		result, err := ExecuteCode(code, program.RegisterCount, buffer)
		if err != nil {
			t.Fatalf("value %d: ExecuteCode: %v", value, err)
		}
		if result != int64(value) {
			t.Fatalf("value %d: result = %d", value, result)
		}
	}
}

func TestCertificateRecomputationDetectsTampering(t *testing.T) {
	program := &Program{
		RegisterCount: 2,
		BufferSize:    1,
		Instructions: []Instruction{
			constInstruction(0, 0),
			load1Instruction(1, 0),
			returnInstruction(1),
		},
	}
	certificate := mustValidate(t, program)
	if err := VerifyCertificate(program, certificate); err != nil {
		t.Fatalf("valid certificate: %v", err)
	}

	certificate.Reads[0].Offset.Max = 1
	if err := VerifyCertificate(program, certificate); !errors.Is(err, ErrCertificate) {
		t.Fatalf("tampered certificate error = %v, want ErrCertificate", err)
	}
}

func TestStructuralLimitsAndBackwardBranches(t *testing.T) {
	backward := &Program{
		RegisterCount: 2,
		BufferSize:    1,
		Instructions: []Instruction{
			constInstruction(0, 0),
			compareInstruction(0, 0, CmpEq, 0),
			returnInstruction(0),
		},
	}
	if _, err := ValidateProgram(backward); !errors.Is(err, ErrInvalidProgram) {
		t.Fatalf("backward branch error = %v, want ErrInvalidProgram", err)
	}

	instructions := make([]Instruction, MaxInstructions+1)
	for pc := range instructions {
		instructions[pc] = constInstruction(0, 0)
	}
	tooMany := &Program{RegisterCount: 1, BufferSize: 0, Instructions: instructions}
	if _, err := ValidateProgram(tooMany); !errors.Is(err, ErrInvalidProgram) {
		t.Fatalf("long program error = %v, want ErrInvalidProgram", err)
	}

	exactLimitInstructions := make([]Instruction, MaxInstructions)
	for pc := range exactLimitInstructions {
		if pc == 0 {
			exactLimitInstructions[pc] = constInstruction(0, 0)
			continue
		}
		exactLimitInstructions[pc] = returnInstruction(0)
	}
	exactLimit := &Program{
		RegisterCount: 1,
		BufferSize:    0,
		Instructions:  exactLimitInstructions,
	}
	if _, err := ValidateProgram(exactLimit); err != nil {
		t.Fatalf("exact %d instruction limit: %v", MaxInstructions, err)
	}

	zeroRegisters := &Program{
		RegisterCount: 0,
		BufferSize:    0,
		Instructions:  []Instruction{returnInstruction(0)},
	}
	if _, err := ValidateProgram(zeroRegisters); !errors.Is(err, ErrInvalidProgram) {
		t.Fatalf("zero register error = %v, want ErrInvalidProgram", err)
	}
}

func TestReadableCertificateExample(t *testing.T) {
	program := &Program{
		RegisterCount: 3,
		BufferSize:    8,
		Instructions: []Instruction{
			constInstruction(0, -2),
			constInstruction(1, 3),
			addInstruction(2, 0, 1),
			load1Instruction(1, 2),
			returnInstruction(1),
		},
	}
	certificate := mustValidate(t, program)
	if len(certificate.Reads) != 1 {
		t.Fatalf("reads = %+v", certificate.Reads)
	}
	read := certificate.Reads[0]
	if read.PC != 3 || read.Width != 1 || read.Offset != (Interval{Min: 1, Max: 1}) {
		t.Fatalf("read certificate = %+v", read)
	}
	if !read.Registers[2].Initialized || read.Registers[2].Interval != (Interval{Min: 1, Max: 1}) {
		t.Fatalf("certificate register state = %+v", read.Registers)
	}

	code := encodeForTest(t, program)
	if result, err := ExecuteCode(code, program.RegisterCount, []byte{9, 7}); err != nil || result != 7 {
		t.Fatalf("ExecuteCode = (%d,%v), want 7", result, err)
	}

	if err := VerifyCodeCertificate(code, program.RegisterCount, program.BufferSize, certificate); err != nil {
		t.Fatalf("VerifyCodeCertificate: %v", err)
	}
}

func TestAllComparisonOperatorsNarrowAndExecute(t *testing.T) {
	for _, testCase := range []struct {
		operator          uint8
		expectedReachable bool
	}{
		{operator: CmpEq, expectedReachable: true},
		{operator: CmpNe, expectedReachable: false},
		{operator: CmpLt, expectedReachable: false},
		{operator: CmpLe, expectedReachable: true},
		{operator: CmpGt, expectedReachable: false},
		{operator: CmpGe, expectedReachable: true},
	} {
		operator := testCase.operator
		t.Run(fmt.Sprintf("operator-%d", operator), func(t *testing.T) {
			program := &Program{
				RegisterCount: 3,
				BufferSize:    1,
				Instructions: []Instruction{
					constInstruction(0, 0),
					constInstruction(1, 0),
					compareInstruction(0, 1, operator, 5),
					constInstruction(2, 0),
					returnInstruction(2),
					constInstruction(2, 0),
					returnInstruction(2),
				},
			}
			certificate := mustValidate(t, program)
			if certificate.Points[5].Reachable != testCase.expectedReachable {
				t.Fatalf("target reachability for operator %d = %v, want %v", operator, certificate.Points[5].Reachable, testCase.expectedReachable)
			}
			code := encodeForTest(t, program)
			if _, err := ExecuteCode(code, program.RegisterCount, []byte{42}); err != nil {
				t.Fatalf("operator %d: ExecuteCode: %v", operator, err)
			}
		})
	}
}
