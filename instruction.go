package q217

import (
	"encoding/binary"
	"fmt"
)

// DecodeCode decodes 16-byte little-endian instructions.
func DecodeCode(code []byte) ([]Instruction, error) {
	if len(code) == 0 || len(code)%instructionSize != 0 {
		return nil, fmt.Errorf("%w: encoded instruction length must be a multiple of %d", ErrInvalidProgram, instructionSize)
	}
	if len(code)/instructionSize > MaxInstructions {
		return nil, fmt.Errorf("%w: more than %d instructions", ErrInvalidProgram, MaxInstructions)
	}

	instructions := make([]Instruction, len(code)/instructionSize)
	for pc := range instructions {
		raw := code[pc*instructionSize : (pc+1)*instructionSize]
		if raw[14] != 0 || raw[15] != 0 {
			return nil, fmt.Errorf("%w: reserved instruction bytes must be zero", ErrInvalidProgram)
		}
		instructions[pc] = Instruction{
			Op:     raw[0],
			Dst:    raw[1],
			Src1:   raw[2],
			Src2:   raw[3],
			Imm:    int64(binary.LittleEndian.Uint64(raw[4:12])),
			Target: binary.LittleEndian.Uint16(raw[12:14]),
		}
	}
	return instructions, nil
}

// EncodeProgram validates and encodes a program as 16-byte little-endian instructions.
func EncodeProgram(program *Program) ([]byte, error) {
	if program == nil {
		return nil, fmt.Errorf("%w: nil program", ErrInvalidProgram)
	}
	if err := validateStructure(program); err != nil {
		return nil, err
	}

	code := make([]byte, len(program.Instructions)*instructionSize)
	for pc, instruction := range program.Instructions {
		raw := code[pc*instructionSize : (pc+1)*instructionSize]
		raw[0] = instruction.Op
		raw[1] = instruction.Dst
		raw[2] = instruction.Src1
		raw[3] = instruction.Src2
		binary.LittleEndian.PutUint64(raw[4:12], uint64(instruction.Imm))
		binary.LittleEndian.PutUint16(raw[12:14], instruction.Target)
	}
	return code, nil
}

func validateStructure(program *Program) error {
	if program == nil {
		return fmt.Errorf("%w: nil program", ErrInvalidProgram)
	}
	if program.RegisterCount < 1 || program.RegisterCount > MaxRegisters {
		return fmt.Errorf("%w: register count must be in [1,%d]", ErrInvalidProgram, MaxRegisters)
	}
	if program.BufferSize < 0 {
		return fmt.Errorf("%w: buffer size cannot be negative", ErrInvalidProgram)
	}
	if len(program.Instructions) < 1 || len(program.Instructions) > MaxInstructions {
		return fmt.Errorf("%w: instruction count must be in [1,%d]", ErrInvalidProgram, MaxInstructions)
	}

	validRegister := func(register uint8) bool {
		return int(register) < program.RegisterCount
	}
	hasReturn := false

	for pc, instruction := range program.Instructions {
		switch instruction.Op {
		case OpConst:
			if !validRegister(instruction.Dst) || instruction.Src1 != 0 || instruction.Src2 != 0 || instruction.Target != 0 {
				return fmt.Errorf("%w: malformed const at pc %d", ErrInvalidProgram, pc)
			}
		case OpAdd:
			if !validRegister(instruction.Dst) || !validRegister(instruction.Src1) || !validRegister(instruction.Src2) || instruction.Target != 0 {
				return fmt.Errorf("%w: malformed add at pc %d", ErrInvalidProgram, pc)
			}
		case OpCmp:
			if instruction.Dst != 0 || !validRegister(instruction.Src1) || !validRegister(instruction.Src2) {
				return fmt.Errorf("%w: malformed compare at pc %d", ErrInvalidProgram, pc)
			}
			if instruction.Imm < int64(CmpEq) || instruction.Imm > int64(CmpGe) {
				return fmt.Errorf("%w: invalid comparison operator at pc %d", ErrInvalidProgram, pc)
			}
			if int(instruction.Target) <= pc || int(instruction.Target) >= len(program.Instructions) {
				return fmt.Errorf("%w: compare at pc %d must target a later instruction", ErrInvalidProgram, pc)
			}
		case OpLoad1, OpLoad4:
			if !validRegister(instruction.Dst) || !validRegister(instruction.Src1) || instruction.Src2 != 0 || instruction.Target != 0 {
				return fmt.Errorf("%w: malformed load at pc %d", ErrInvalidProgram, pc)
			}
		case OpReturn:
			if instruction.Dst != 0 || !validRegister(instruction.Src1) || instruction.Src2 != 0 || instruction.Target != 0 {
				return fmt.Errorf("%w: malformed return at pc %d", ErrInvalidProgram, pc)
			}
			hasReturn = true
		default:
			return fmt.Errorf("%w: unknown opcode %d at pc %d", ErrInvalidProgram, instruction.Op, pc)
		}

		if instruction.Op != OpReturn && instruction.Op != OpCmp && pc+1 >= len(program.Instructions) {
			return fmt.Errorf("%w: pc %d falls through the program without return", ErrInvalidProgram, pc)
		}
	}
	if !hasReturn {
		return fmt.Errorf("%w: program has no return", ErrInvalidProgram)
	}
	return nil
}
