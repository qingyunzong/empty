package q217

import (
	"encoding/binary"
	"fmt"
)

// ExecuteCode decodes and runs bytecode with a concrete fixed-size buffer.
func ExecuteCode(code []byte, registerCount int, buffer []byte) (int64, error) {
	instructions, err := DecodeCode(code)
	if err != nil {
		return 0, err
	}
	return ExecuteProgram(&Program{
		Instructions:  instructions,
		RegisterCount: registerCount,
		BufferSize:    int64(len(buffer)),
	}, buffer)
}

// ExecuteProgram runs the concrete interpreter and returns the program result.
func ExecuteProgram(program *Program, buffer []byte) (int64, error) {
	if err := validateStructure(program); err != nil {
		return 0, err
	}
	if int64(len(buffer)) != program.BufferSize {
		return 0, fmt.Errorf("%w: buffer length does not match program", ErrInvalidProgram)
	}

	registers := make([]int64, program.RegisterCount)
	initialized := make([]bool, program.RegisterCount)
	pc := 0
	for pc < len(program.Instructions) {
		instruction := program.Instructions[pc]
		switch instruction.Op {
		case OpConst:
			registers[instruction.Dst] = instruction.Imm
			initialized[instruction.Dst] = true
			pc++

		case OpAdd:
			if !initialized[instruction.Src1] {
				return 0, fmt.Errorf("%w r%d at pc %d", ErrUninitializedRegister, instruction.Src1, pc)
			}
			if !initialized[instruction.Src2] {
				return 0, fmt.Errorf("%w r%d at pc %d", ErrUninitializedRegister, instruction.Src2, pc)
			}
			sum, ok := checkedAdd(registers[instruction.Src1], registers[instruction.Src2])
			if !ok {
				return 0, fmt.Errorf("%w at pc %d", ErrOverflow, pc)
			}
			registers[instruction.Dst] = sum
			initialized[instruction.Dst] = true
			pc++

		case OpCmp:
			if !initialized[instruction.Src1] {
				return 0, fmt.Errorf("%w r%d at pc %d", ErrUninitializedRegister, instruction.Src1, pc)
			}
			if !initialized[instruction.Src2] {
				return 0, fmt.Errorf("%w r%d at pc %d", ErrUninitializedRegister, instruction.Src2, pc)
			}
			if compare(registers[instruction.Src1], registers[instruction.Src2], uint8(instruction.Imm)) {
				pc = int(instruction.Target)
			} else {
				pc++
			}

		case OpLoad1, OpLoad4:
			if !initialized[instruction.Src1] {
				return 0, fmt.Errorf("%w r%d at pc %d", ErrUninitializedRegister, instruction.Src1, pc)
			}
			offset := registers[instruction.Src1]
			width := int64(1)
			if instruction.Op == OpLoad4 {
				width = 4
			}
			if offset < 0 || offset > int64(len(buffer))-width {
				return 0, fmt.Errorf("%w at pc %d", ErrUnsafeRead, pc)
			}
			if instruction.Op == OpLoad1 {
				registers[instruction.Dst] = int64(buffer[offset])
			} else {
				registers[instruction.Dst] = int64(int32(binary.LittleEndian.Uint32(buffer[offset : offset+4])))
			}
			initialized[instruction.Dst] = true
			pc++

		case OpReturn:
			if !initialized[instruction.Src1] {
				return 0, fmt.Errorf("%w r%d at pc %d", ErrUninitializedRegister, instruction.Src1, pc)
			}
			return registers[instruction.Src1], nil
		}
	}
	return 0, fmt.Errorf("%w: execution reached end without return", ErrInvalidProgram)
}

func compare(left, right int64, operator uint8) bool {
	switch operator {
	case CmpEq:
		return left == right
	case CmpNe:
		return left != right
	case CmpLt:
		return left < right
	case CmpLe:
		return left <= right
	case CmpGt:
		return left > right
	case CmpGe:
		return left >= right
	default:
		return false
	}
}
