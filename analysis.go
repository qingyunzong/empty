package q217

import (
	"fmt"
	"math"
)

type registerState struct {
	initialized bool
	value       Interval
}

// ValidateCode decodes and validates bytecode against the given buffer size.
func ValidateCode(code []byte, registerCount int, bufferSize int64) (*Certificate, error) {
	instructions, err := DecodeCode(code)
	if err != nil {
		return nil, err
	}
	return ValidateProgram(&Program{
		Instructions:  instructions,
		RegisterCount: registerCount,
		BufferSize:    bufferSize,
	})
}

// ValidateProgram performs interval data-flow analysis and returns read certificates.
func ValidateProgram(program *Program) (*Certificate, error) {
	if err := validateStructure(program); err != nil {
		return nil, err
	}

	registerCount := program.RegisterCount
	points := make([][]registerState, len(program.Instructions))
	reachable := make([]bool, len(program.Instructions))
	points[0] = bottomState(registerCount)
	reachable[0] = true

	certificate := &Certificate{
		RegisterCount: registerCount,
		BufferSize:    program.BufferSize,
		Reads:         make([]ReadCertificate, 0),
		Points:        make([]ProgramPoint, len(program.Instructions)),
	}
	reachedReturn := false

	for pc := range program.Instructions {
		if !reachable[pc] {
			continue
		}
		state := cloneState(points[pc])
		instruction := program.Instructions[pc]

		switch instruction.Op {
		case OpConst:
			state[instruction.Dst] = registerState{
				initialized: true,
				value:       Interval{Min: instruction.Imm, Max: instruction.Imm},
			}
			merge(points, reachable, pc+1, state)

		case OpAdd:
			left, err := initializedValue(state, instruction.Src1, pc)
			if err != nil {
				return nil, err
			}
			right, err := initializedValue(state, instruction.Src2, pc)
			if err != nil {
				return nil, err
			}
			minimum, ok := checkedAdd(left.Min, right.Min)
			if !ok {
				return nil, fmt.Errorf("%w at pc %d", ErrOverflow, pc)
			}
			maximum, ok := checkedAdd(left.Max, right.Max)
			if !ok {
				return nil, fmt.Errorf("%w at pc %d", ErrOverflow, pc)
			}
			state[instruction.Dst] = registerState{
				initialized: true,
				value:       Interval{Min: minimum, Max: maximum},
			}
			merge(points, reachable, pc+1, state)

		case OpCmp:
			if _, err := initializedValue(state, instruction.Src1, pc); err != nil {
				return nil, err
			}
			if _, err := initializedValue(state, instruction.Src2, pc); err != nil {
				return nil, err
			}
			trueState, falseState := narrowCompare(state, instruction.Src1, instruction.Src2, uint8(instruction.Imm))
			if nonEmpty(trueState[instruction.Src1].value) {
				merge(points, reachable, int(instruction.Target), trueState)
			}
			if nonEmpty(falseState[instruction.Src1].value) {
				merge(points, reachable, pc+1, falseState)
			}

		case OpLoad1, OpLoad4:
			offset, err := initializedValue(state, instruction.Src1, pc)
			if err != nil {
				return nil, err
			}
			width := int64(1)
			if instruction.Op == OpLoad4 {
				width = 4
			}
			if offset.Min < 0 || offset.Max > program.BufferSize-width {
				return nil, fmt.Errorf("%w at pc %d", ErrUnsafeRead, pc)
			}
			certificate.Reads = append(certificate.Reads, ReadCertificate{
				PC:         pc,
				Width:      int(width),
				BufferSize: program.BufferSize,
				Offset:     offset,
				Registers:  exportState(state),
			})
			loaded := Interval{Min: 0, Max: math.MaxUint8}
			if instruction.Op == OpLoad4 {
				loaded = Interval{Min: math.MinInt32, Max: math.MaxInt32}
			}
			state[instruction.Dst] = registerState{initialized: true, value: loaded}
			merge(points, reachable, pc+1, state)

		case OpReturn:
			if _, err := initializedValue(state, instruction.Src1, pc); err != nil {
				return nil, err
			}
			reachedReturn = true
		}
	}

	if !reachedReturn {
		return nil, fmt.Errorf("%w: no reachable return", ErrInvalidProgram)
	}
	for pc := range points {
		state := points[pc]
		if state == nil {
			state = bottomState(registerCount)
		}
		certificate.Points[pc] = ProgramPoint{
			PC:        pc,
			Reachable: reachable[pc],
			Registers: exportState(state),
		}
	}
	return certificate, nil
}

func bottomState(registerCount int) []registerState {
	return make([]registerState, registerCount)
}

func cloneState(state []registerState) []registerState {
	clone := make([]registerState, len(state))
	copy(clone, state)
	return clone
}

func merge(points [][]registerState, reachable []bool, target int, incoming []registerState) {
	if target >= len(points) {
		return
	}
	if !reachable[target] {
		reachable[target] = true
		points[target] = cloneState(incoming)
		return
	}

	existing := points[target]
	for register := range existing {
		switch {
		case !existing[register].initialized || !incoming[register].initialized:
			existing[register] = registerState{}
		default:
			existing[register].value.Min = min(existing[register].value.Min, incoming[register].value.Min)
			existing[register].value.Max = max(existing[register].value.Max, incoming[register].value.Max)
		}
	}
}

func initializedValue(state []registerState, register uint8, pc int) (Interval, error) {
	if !state[register].initialized {
		return Interval{}, fmt.Errorf("%w r%d at pc %d", ErrUninitializedRegister, register, pc)
	}
	return state[register].value, nil
}

func checkedAdd(left, right int64) (int64, bool) {
	sum := left + right
	if (sum > left) != (right > 0) {
		return 0, false
	}
	return sum, true
}

func nonEmpty(interval Interval) bool {
	return interval.Min <= interval.Max
}

func narrowCompare(state []registerState, leftRegister, rightRegister uint8, operator uint8) ([]registerState, []registerState) {
	trueState := cloneState(state)
	falseState := cloneState(state)
	left := state[leftRegister].value
	right := state[rightRegister].value
	if leftRegister == rightRegister {
		if operator == CmpLt {
			trueState[leftRegister].value = Interval{Min: 1, Max: 0}
			falseState[leftRegister].value = left
			return trueState, falseState
		}
		if operator == CmpNe {
			trueState[leftRegister].value = Interval{Min: 1, Max: 0}
			falseState[leftRegister].value = left
			return trueState, falseState
		}
		falseState[leftRegister].value = Interval{Min: 1, Max: 0}
		return trueState, falseState
	}
	empty := Interval{Min: 1, Max: 0}
	trueState[leftRegister].value = empty
	trueState[rightRegister].value = empty
	falseState[leftRegister].value = empty
	falseState[rightRegister].value = empty

	switch operator {
	case CmpEq:
		interval := Interval{Min: max(left.Min, right.Min), Max: min(left.Max, right.Max)}
		if nonEmpty(interval) {
			trueState[leftRegister].value = interval
			trueState[rightRegister].value = interval
		}
		if !(left.Min == left.Max && right.Min == right.Max && left.Min == right.Min) {
			falseState[leftRegister].value = left
			falseState[rightRegister].value = right
		}

	case CmpNe:
		if !(left.Min == left.Max && right.Min == right.Max && left.Min == right.Min) {
			trueState[leftRegister].value = left
			trueState[rightRegister].value = right
		}
		interval := Interval{Min: max(left.Min, right.Min), Max: min(left.Max, right.Max)}
		if nonEmpty(interval) {
			falseState[leftRegister].value = interval
			falseState[rightRegister].value = interval
		}

	case CmpLt:
		if left.Min < right.Max {
			trueState[leftRegister].value = Interval{
				Min: left.Min,
				Max: min(left.Max, decrement(right.Max)),
			}
			trueState[rightRegister].value = Interval{
				Min: max(right.Min, increment(left.Min)),
				Max: right.Max,
			}
		}
		if left.Max >= right.Min {
			falseState[leftRegister].value = Interval{
				Min: max(left.Min, right.Min),
				Max: left.Max,
			}
			falseState[rightRegister].value = Interval{
				Min: right.Min,
				Max: min(right.Max, left.Max),
			}
		}

	case CmpLe:
		if left.Min <= right.Max {
			trueState[leftRegister].value = Interval{
				Min: left.Min,
				Max: min(left.Max, right.Max),
			}
			trueState[rightRegister].value = Interval{
				Min: max(right.Min, left.Min),
				Max: right.Max,
			}
		}
		if left.Max > right.Min {
			falseState[leftRegister].value = Interval{
				Min: max(left.Min, increment(right.Min)),
				Max: left.Max,
			}
			falseState[rightRegister].value = Interval{
				Min: right.Min,
				Max: min(right.Max, decrement(left.Max)),
			}
		}

	case CmpGt:
		if left.Max > right.Min {
			trueState[leftRegister].value = Interval{
				Min: max(left.Min, increment(right.Min)),
				Max: left.Max,
			}
			trueState[rightRegister].value = Interval{
				Min: right.Min,
				Max: min(right.Max, decrement(left.Max)),
			}
		}
		if left.Min <= right.Max {
			falseState[leftRegister].value = Interval{
				Min: left.Min,
				Max: min(left.Max, right.Max),
			}
			falseState[rightRegister].value = Interval{
				Min: max(right.Min, left.Min),
				Max: right.Max,
			}
		}

	case CmpGe:
		if left.Max >= right.Min {
			trueState[leftRegister].value = Interval{
				Min: max(left.Min, right.Min),
				Max: left.Max,
			}
			trueState[rightRegister].value = Interval{
				Min: right.Min,
				Max: min(right.Max, left.Max),
			}
		}
		if left.Min < right.Max {
			falseState[leftRegister].value = Interval{
				Min: left.Min,
				Max: min(left.Max, decrement(right.Max)),
			}
			falseState[rightRegister].value = Interval{
				Min: max(right.Min, increment(left.Min)),
				Max: right.Max,
			}
		}
	}

	if !nonEmpty(trueState[leftRegister].value) {
		trueState[leftRegister].value = Interval{Min: 1, Max: 0}
	}
	if !nonEmpty(falseState[leftRegister].value) {
		falseState[leftRegister].value = Interval{Min: 1, Max: 0}
	}
	return trueState, falseState
}

func contains(interval Interval, value int64) bool {
	return interval.Min <= value && value <= interval.Max
}

func increment(value int64) int64 {
	if value == math.MaxInt64 {
		return math.MaxInt64
	}
	return value + 1
}

func decrement(value int64) int64 {
	if value == math.MinInt64 {
		return math.MinInt64
	}
	return value - 1
}

func exportState(state []registerState) []RegisterInterval {
	exported := make([]RegisterInterval, len(state))
	for register, value := range state {
		exported[register] = RegisterInterval{
			Interval:    value.value,
			Initialized: value.initialized,
		}
	}
	return exported
}
