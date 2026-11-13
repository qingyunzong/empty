package dataeng

import (
	"context"
	"fmt"
	"math"
	"reflect"
)

// Reader is the primary collector contract. A read must return every register
// in the requested interval and must honour the supplied context.
type Reader interface {
	ReadRange(ctx context.Context, r ReadRange) ([]Register, error)
}

// ReadingReader returns a structured observation for one interval, including
// an optional restart counter sampled with that read.
type ReadingReader interface {
	ReadRange(ctx context.Context, r ReadRange) (RangeReading, error)
}

// RegisterReader is the common Modbus helper shape: start address plus count,
// returning consecutive words.
type RegisterReader interface {
	ReadRegisters(ctx context.Context, start, count uint16) ([]uint16, error)
}

// ReaderFunc adapts a function to Reader.
type ReaderFunc func(context.Context, ReadRange) ([]Register, error)

// ReadRange implements Reader.
func (f ReaderFunc) ReadRange(ctx context.Context, r ReadRange) ([]Register, error) {
	return f(ctx, r)
}

// RegisterReaderFunc adapts a function to RegisterReader.
type RegisterReaderFunc func(context.Context, uint16, uint16) ([]uint16, error)

// ReadRegisters implements RegisterReader.
func (f RegisterReaderFunc) ReadRegisters(ctx context.Context, start, count uint16) ([]uint16, error) {
	return f(ctx, start, count)
}

// ReadingReaderFunc adapts a function to ReadingReader.
type ReadingReaderFunc func(context.Context, ReadRange) (RangeReading, error)

// ReadRange implements ReadingReader.
func (f ReadingReaderFunc) ReadRange(ctx context.Context, r ReadRange) (RangeReading, error) {
	return f(ctx, r)
}

// Aliases used by collectors with slightly different vocabulary.
type (
	RangeReader    = Reader
	ModbusReader   = Reader
	IntervalReader = Reader
)

type readingResult struct {
	registers       []Register
	restartCount    uint16
	hasRestartCount bool
}

func (c *Coordinator) readOnce(ctx context.Context, r ReadRange) (readingResult, error) {
	if c.reader == nil {
		return readingResult{}, ErrReaderUnsupported
	}
	readerValue := reflect.ValueOf(c.reader)
	if readerValue.Kind() == reflect.Pointer && readerValue.IsNil() {
		return readingResult{}, ErrReaderUnsupported
	}

	switch reader := c.reader.(type) {
	case Reader:
		registers, err := reader.ReadRange(ctx, r)
		if err != nil {
			return readingResult{}, err
		}
		return readingResult{registers: registers}, nil
	case ReadingReader:
		reading, err := reader.ReadRange(ctx, r)
		if err != nil {
			return readingResult{}, err
		}
		return readingResult{
			registers:       reading.Registers,
			restartCount:    reading.RestartCount,
			hasRestartCount: reading.HasRestartCount,
		}, nil
	case RegisterReader:
		values, err := reader.ReadRegisters(ctx, r.RangeStart(), r.RangeCount())
		if err != nil {
			return readingResult{}, err
		}
		return readingResult{registers: sequentialRegisters(r.RangeStart(), values)}, nil
	case ReaderFunc:
		registers, err := reader(ctx, r)
		if err != nil {
			return readingResult{}, err
		}
		return readingResult{registers: registers}, nil
	case RegisterReaderFunc:
		values, err := reader(ctx, r.RangeStart(), r.RangeCount())
		if err != nil {
			return readingResult{}, err
		}
		return readingResult{registers: sequentialRegisters(r.RangeStart(), values)}, nil
	case ReadingReaderFunc:
		reading, err := reader(ctx, r)
		if err != nil {
			return readingResult{}, err
		}
		return readingResult{
			registers:       reading.Registers,
			restartCount:    reading.RestartCount,
			hasRestartCount: reading.HasRestartCount,
		}, nil
	}

	return readByReflection(c.reader, ctx, r)
}

func sequentialRegisters(start uint16, values []uint16) []Register {
	registers := make([]Register, len(values))
	for i, value := range values {
		registers[i] = Register{Address: start + uint16(i), Value: value}
	}
	return registers
}

var (
	contextType = reflect.TypeOf((*context.Context)(nil)).Elem()
	errorType   = reflect.TypeOf((*error)(nil)).Elem()
	rangeType   = reflect.TypeOf(ReadRange{})
)

func readByReflection(reader any, ctx context.Context, r ReadRange) (readingResult, error) {
	value := reflect.ValueOf(reader)
	if !value.IsValid() {
		return readingResult{}, ErrReaderUnsupported
	}

	if value.Kind() == reflect.Func {
		return callReaderFunc(value, ctx, r)
	}

	for _, name := range []string{
		"ReadRange",
		"ReadRegisters",
		"ReadHoldingRegisters",
		"ReadInterval",
		"Read",
		"Poll",
	} {
		method := value.MethodByName(name)
		if !method.IsValid() {
			continue
		}
		if result, ok, err := callReaderMethod(method, ctx, r); ok {
			return result, err
		}
	}

	return readingResult{}, fmt.Errorf("%w: %T", ErrReaderUnsupported, reader)
}

func callReaderFunc(fn reflect.Value, ctx context.Context, r ReadRange) (readingResult, error) {
	if result, ok, err := invokeReader(fn, ctx, r); ok {
		return result, err
	}
	return readingResult{}, fmt.Errorf("%w: %s", ErrReaderUnsupported, fn.Type())
}

func callReaderMethod(method reflect.Value, ctx context.Context, r ReadRange) (readingResult, bool, error) {
	return invokeReader(method, ctx, r)
}

func invokeReader(fn reflect.Value, ctx context.Context, r ReadRange) (readingResult, bool, error) {
	typ := fn.Type()
	if typ.NumOut() < 1 || typ.NumOut() > 2 {
		return readingResult{}, false, nil
	}
	if typ.NumOut() == 2 && !typ.Out(1).Implements(errorType) {
		return readingResult{}, false, nil
	}

	args, ok := readerArgs(typ, ctx, r)
	if !ok {
		return readingResult{}, false, nil
	}

	outputs, err := safeCall(fn, args)
	if err != nil {
		return readingResult{}, true, err
	}
	if len(outputs) == 2 {
		if callErr := reflectedError(outputs[1]); callErr != nil {
			return readingResult{}, true, callErr
		}
	}
	if len(outputs) == 0 || !outputs[0].IsValid() {
		return readingResult{}, true, fmt.Errorf("%w: reader returned no value", ErrIncomplete)
	}

	result, err := readingFromValue(outputs[0], r)
	return result, true, err
}

func readerArgs(typ reflect.Type, ctx context.Context, r ReadRange) ([]reflect.Value, bool) {
	contextValue := reflect.ValueOf(ctx)
	rangeValue := reflect.ValueOf(r)

	switch {
	case typ.NumIn() == 2 &&
		typ.In(0).Implements(contextType) &&
		rangeValue.Type().AssignableTo(typ.In(1)):
		return []reflect.Value{contextValue, rangeValue}, true
	case typ.NumIn() == 2 &&
		rangeValue.Type().AssignableTo(typ.In(0)) &&
		typ.In(1).Implements(contextType):
		return []reflect.Value{rangeValue, contextValue}, true
	case typ.NumIn() == 3 &&
		typ.In(0).Implements(contextType) &&
		isUnsigned(typ.In(1)) &&
		isUnsigned(typ.In(2)):
		return []reflect.Value{
			contextValue,
			numericArg(r.RangeStart(), typ.In(1)),
			numericArg(r.RangeCount(), typ.In(2)),
		}, true
	case typ.NumIn() == 4 &&
		typ.In(0).Implements(contextType) &&
		isUnsigned(typ.In(1)) &&
		isUnsigned(typ.In(2)) &&
		isUnsigned(typ.In(3)):
		return []reflect.Value{
			contextValue,
			numericArg(0, typ.In(1)),
			numericArg(r.RangeStart(), typ.In(2)),
			numericArg(r.RangeCount(), typ.In(3)),
		}, true
	default:
		return nil, false
	}
}

func numericArg(value uint16, typ reflect.Type) reflect.Value {
	number := reflect.ValueOf(value)
	if number.Type().AssignableTo(typ) {
		return number
	}
	return number.Convert(typ)
}

func isUnsigned(typ reflect.Type) bool {
	switch typ.Kind() {
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		return true
	default:
		return false
	}
}

func safeCall(fn reflect.Value, args []reflect.Value) (outputs []reflect.Value, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			outputs = nil
			err = fmt.Errorf("dataeng: reader panic: %v", recovered)
		}
	}()
	return fn.Call(args), nil
}

func reflectedError(value reflect.Value) error {
	if !value.IsValid() {
		return nil
	}
	switch value.Kind() {
	case reflect.Interface, reflect.Pointer:
		if value.IsNil() {
			return nil
		}
	}
	if value.Type().Implements(errorType) {
		err, _ := value.Interface().(error)
		return err
	}
	return nil
}

func readingFromValue(value reflect.Value, r ReadRange) (readingResult, error) {
	registers, err := registersFromValue(value, r.RangeStart())
	if err != nil {
		return readingResult{}, err
	}

	restartValue, hasRestart := numberField(value, "RestartCount", "RestartCounter", "PowerCycleCount")
	return readingResult{
		registers:       registers,
		restartCount:    restartValue,
		hasRestartCount: hasRestart,
	}, nil
}

func registersFromValue(value reflect.Value, start uint16) ([]Register, error) {
	value = indirectValue(value)
	if !value.IsValid() {
		return nil, fmt.Errorf("%w: reader returned nil", ErrIncomplete)
	}

	if registers, ok := value.Interface().([]Register); ok {
		return registers, nil
	}

	switch value.Kind() {
	case reflect.Slice, reflect.Array:
		return registersFromSequence(value, start)
	case reflect.Map:
		return registersFromMap(value)
	case reflect.Struct:
		if field := value.FieldByName("Registers"); field.IsValid() {
			return registersFromValue(field, start)
		}
		if field := value.FieldByName("Values"); field.IsValid() {
			return registersFromValue(field, start)
		}
		if field := value.FieldByName("Data"); field.IsValid() {
			return registersFromValue(field, start)
		}
		if address, err := numberFieldRequired(value, "Address", "Addr", "Offset"); err == nil {
			registerValue, valueErr := numberFieldRequired(value, "Value", "Val", "Data")
			if valueErr != nil {
				return nil, valueErr
			}
			return []Register{{Address: address, Value: registerValue}}, nil
		}
		return nil, fmt.Errorf("%w: unsupported reader result %s", ErrReaderUnsupported, value.Type())
	default:
		return nil, fmt.Errorf("%w: unsupported reader result %s", ErrReaderUnsupported, value.Type())
	}
}

func indirectValue(value reflect.Value) reflect.Value {
	for value.IsValid() && (value.Kind() == reflect.Interface || value.Kind() == reflect.Pointer) {
		if value.IsNil() {
			return reflect.Value{}
		}
		value = value.Elem()
	}
	return value
}

func registersFromSequence(sequence reflect.Value, start uint16) ([]Register, error) {
	registers := make([]Register, 0, sequence.Len())
	elementType := sequence.Type().Elem()

	for i := 0; i < sequence.Len(); i++ {
		element := indirectValue(sequence.Index(i))
		if !element.IsValid() {
			return nil, fmt.Errorf("%w: nil register at index %d", ErrIncomplete, i)
		}

		switch element.Kind() {
		case reflect.Struct:
			address, err := numberFieldRequired(element, "Address", "Addr", "Register", "Offset")
			if err != nil {
				return nil, fmt.Errorf("%w: %v", ErrReaderUnsupported, err)
			}
			value, err := numberFieldRequired(element, "Value", "Val", "Data")
			if err != nil {
				return nil, fmt.Errorf("%w: %v", ErrReaderUnsupported, err)
			}
			registers = append(registers, Register{Address: address, Value: value})
		case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr,
			reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
			registerValue, err := reflectUint16(element)
			if err != nil {
				return nil, err
			}
			address := start + uint16(i)
			if elementType.Kind() == reflect.Array && elementType.Len() > 1 {
				address = start + uint16(i*elementType.Len())
			}
			registers = append(registers, Register{Address: address, Value: registerValue})
		default:
			return nil, fmt.Errorf("%w: unsupported register element %s", ErrReaderUnsupported, element.Type())
		}
	}
	return registers, nil
}

func registersFromMap(registerMap reflect.Value) ([]Register, error) {
	registers := make([]Register, 0, registerMap.Len())
	iter := registerMap.MapRange()
	for iter.Next() {
		key := indirectValue(iter.Key())
		value := indirectValue(iter.Value())
		if !key.IsValid() || !value.IsValid() {
			return nil, fmt.Errorf("%w: nil map entry", ErrIncomplete)
		}
		address, err := reflectUint16(key)
		if err != nil {
			return nil, fmt.Errorf("%w: map key: %v", ErrReaderUnsupported, err)
		}
		var registerValue uint16
		if value.Kind() == reflect.Struct {
			registerValue, err = numberFieldRequired(value, "Value", "Val", "Data")
		} else {
			registerValue, err = reflectUint16(value)
		}
		if err != nil {
			return nil, fmt.Errorf("%w: map value: %v", ErrReaderUnsupported, err)
		}
		registers = append(registers, Register{Address: address, Value: registerValue})
	}
	return registers, nil
}

func numberField(value reflect.Value, names ...string) (uint16, bool) {
	number, err := numberFieldRequired(value, names...)
	return number, err == nil
}

func numberFieldRequired(value reflect.Value, names ...string) (uint16, error) {
	value = indirectValue(value)
	if !value.IsValid() || value.Kind() != reflect.Struct {
		return 0, fmt.Errorf("not a struct")
	}
	for _, name := range names {
		field := value.FieldByName(name)
		if !field.IsValid() {
			continue
		}
		return reflectUint16(indirectValue(field))
	}
	return 0, fmt.Errorf("none of %v present", names)
}

func reflectUint16(value reflect.Value) (uint16, error) {
	value = indirectValue(value)
	if !value.IsValid() {
		return 0, fmt.Errorf("invalid value")
	}
	switch value.Kind() {
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		if value.OverflowUint(16) {
			return 0, fmt.Errorf("value %v exceeds uint16", value.Interface())
		}
		return uint16(value.Uint()), nil
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		number := value.Int()
		if number < 0 || number > math.MaxUint16 {
			return 0, fmt.Errorf("value %d is outside uint16", number)
		}
		return uint16(number), nil
	default:
		return 0, fmt.Errorf("value %s is not an integer", value.Type())
	}
}
