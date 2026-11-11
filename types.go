package q217

import "errors"

const (
	MaxInstructions = 256
	MaxRegisters    = 256
	instructionSize = 16
)

const (
	OpConst uint8 = iota + 1
	OpAdd
	OpCmp
	OpLoad1
	OpLoad4
	OpReturn
)

const (
	CmpEq uint8 = iota + 1
	CmpNe
	CmpLt
	CmpLe
	CmpGt
	CmpGe
)

var (
	ErrInvalidProgram        = errors.New("q217: invalid program")
	ErrUninitializedRegister = errors.New("q217: uninitialized register")
	ErrOverflow              = errors.New("q217: signed integer overflow")
	ErrUnsafeRead            = errors.New("q217: read cannot be proven in bounds")
	ErrCertificate           = errors.New("q217: invalid read certificate")
)

type Interval struct {
	Min int64
	Max int64
}

// RegisterInterval is the abstract value of one register at a program point.
type RegisterInterval struct {
	Interval
	Initialized bool
}

// Instruction is one 16-byte little-endian bytecode instruction after decoding.
type Instruction struct {
	Op     uint8
	Dst    uint8
	Src1   uint8
	Src2   uint8
	Imm    int64
	Target uint16
}

// Program is a structurally typed filter program and its fixed input buffer size.
type Program struct {
	Instructions  []Instruction
	RegisterCount int
	BufferSize    int64
}

// ReadCertificate contains the pre-read abstract state needed to recompute one bounds proof.
type ReadCertificate struct {
	PC         int
	Width      int
	BufferSize int64
	Offset     Interval
	Registers  []RegisterInterval
}

// ProgramPoint records reachability and register intervals immediately before a PC.
type ProgramPoint struct {
	PC        int
	Reachable bool
	Registers []RegisterInterval
}

// Certificate is the complete verifier output for one accepted program.
type Certificate struct {
	RegisterCount int
	BufferSize    int64
	Reads         []ReadCertificate
	Points        []ProgramPoint
}
