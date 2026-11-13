package dataeng

import (
	"errors"
	"fmt"
	"reflect"
)

// Handler reports the outcome of one record. A nil error with an empty reason
// means success. A non-nil error or a non-empty reason means failure. When the
// error is a *ReasonError, its Code is used if the returned reason is empty.
type Handler func(Record) (reasonCode string, err error)

// ErrorHandler is a convenience handler shape for failures whose reason code is
// carried by a *ReasonError.
type ErrorHandler func(Record) error

// ReasonError carries a caller-defined reason code alongside an error.
type ReasonError struct {
	Code string
	Err  error
}

func (e *ReasonError) Error() string {
	if e == nil {
		return "<nil>"
	}
	if e.Err == nil {
		return e.Code
	}
	if e.Code == "" {
		return e.Err.Error()
	}
	return fmt.Sprintf("%s: %v", e.Code, e.Err)
}

func (e *ReasonError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

// RecordError reports a failure that cannot be turned into a valid dead letter,
// such as a failure without a reason code or a reason outside the caller's list.
// Other records in the same batch are still processed.
type RecordError struct {
	Record Record
	Err    error
}

func (e *RecordError) Error() string {
	return fmt.Sprintf("partition %d offset %d: %v", e.Record.Partition, e.Record.Offset, e.Err)
}

func (e *RecordError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

// BatchResult contains the independently routed outcomes of a batch.
type BatchResult struct {
	Delivered   []Record
	DeadLetters []DeadLetter
	Errors      []RecordError
}

// Err joins the per-record errors that could not produce a valid dead letter.
// The delivered records and dead letters remain available in the result.
func (r BatchResult) Err() error {
	if len(r.Errors) == 0 {
		return nil
	}
	joined := make([]error, len(r.Errors))
	for i := range r.Errors {
		joined[i] = &r.Errors[i]
	}
	return errors.Join(joined...)
}

// Failed returns the dead letters accumulated for the batch.
func (r BatchResult) Failed() []DeadLetter {
	return r.DeadLetters
}

// OK reports whether every record was either delivered or dead-lettered
// without a routing error.
func (r BatchResult) OK() bool {
	return len(r.Errors) == 0
}

// ReasonCode is a caller-defined failure classification.
type ReasonCode = string

// ReasonList is a convenience type for an allowed reason-code list.
type ReasonList []string

// ReasonSet is a convenience type for an allowed reason-code set.
type ReasonSet map[string]struct{}

var (
	// ErrUnknownReason is returned when a failure reason is not in the
	// caller-provided list.
	ErrUnknownReason = errors.New("dataeng: reason code is not in the caller list")
	// ErrMissingReason is returned when a failure has no reason code.
	ErrMissingReason = errors.New("dataeng: failed record has no reason code")
	// ErrNilHandler is returned when no batch handler is supplied.
	ErrNilHandler = errors.New("dataeng: nil batch handler")
	// ErrUnsupportedHandler is returned for a handler with an unusable shape.
	ErrUnsupportedHandler = errors.New("dataeng: unsupported batch handler")
	// ErrUnsupportedReasonList is returned for an allowed-reason value that
	// cannot be interpreted as a collection of strings.
	ErrUnsupportedReasonList = errors.New("dataeng: unsupported allowed reason list")
	// ErrNilProcessor is returned when a method is called on a nil Processor.
	ErrNilProcessor = errors.New("dataeng: nil processor")
)

type offsetKey struct {
	partition int
	offset    int64
}

func keyFor(record Record) offsetKey {
	return offsetKey{partition: record.Partition, offset: record.Offset}
}

// Process routes every record independently. Successful records are returned
// as delivered records. Failed records with an allowed reason become dead
// letters; a record that fails with an unlisted reason is reported in Errors
// and does not prevent the rest of the batch from being delivered.
//
// allowedReasons may be a []string, []ReasonCode, ReasonList, ReasonSet,
// map[string]struct{}, map[string]bool, or a comparable string-keyed collection.
// handler may be Handler, ErrorHandler, func(Record) (string, error),
// func(Record) error, func(Record) string, or func(Record) (string, bool).
func Process(records []Record, allowedReasons any, handler any) (BatchResult, error) {
	return process(records, allowedReasons, handler)
}

// ProcessBatch is the slice-oriented form of Process. It returns the delivered
// records and dead letters even when it also returns a routing error.
func ProcessBatch(records []Record, allowedReasons any, handler any) (delivered []Record, deadLetters []DeadLetter, err error) {
	result, err := process(records, allowedReasons, handler)
	return result.Delivered, result.DeadLetters, err
}

// Processor binds a caller-provided reason-code list for repeated batches.
type Processor struct {
	AllowedReasons any
}

// NewProcessor returns a batch processor with the given allowed reason list.
func NewProcessor(allowedReasons any) *Processor {
	return &Processor{AllowedReasons: allowedReasons}
}

// Process runs one batch using the processor's allowed reason list.
func (p *Processor) Process(records []Record, handler any) (BatchResult, error) {
	if p == nil {
		return BatchResult{}, ErrNilProcessor
	}
	return process(records, p.AllowedReasons, handler)
}

// ProcessBatch is the slice-oriented form of Processor.Process.
func (p *Processor) ProcessBatch(records []Record, handler any) (delivered []Record, deadLetters []DeadLetter, err error) {
	result, err := p.Process(records, handler)
	return result.Delivered, result.DeadLetters, err
}

func process(records []Record, allowedReasons any, handler any) (BatchResult, error) {
	var result BatchResult

	allowed, err := normalizeReasons(allowedReasons)
	if err != nil {
		return result, err
	}
	if err := validateHandler(handler); err != nil {
		return result, err
	}

	deadLetterIndex := make(map[offsetKey]int)
	for _, input := range records {
		// Work on a private copy so a handler cannot mutate the caller's
		// payload before it is delivered or preserved in a dead letter.
		record := Record{
			Partition: input.Partition,
			Offset:    input.Offset,
			Payload:   clonePayload(input.Payload),
		}
		handlerRecord := Record{
			Partition: input.Partition,
			Offset:    input.Offset,
			Payload:   clonePayload(record.Payload),
		}

		reason, failed, handlerErr := invokeHandler(handler, handlerRecord)
		if !failed {
			result.Delivered = append(result.Delivered, record)
			continue
		}

		if reason == "" {
			recordErr := ErrMissingReason
			if handlerErr != nil {
				recordErr = fmt.Errorf("%w: %v", ErrMissingReason, handlerErr)
			}
			result.Errors = append(result.Errors, RecordError{Record: record, Err: recordErr})
			continue
		}
		if _, ok := allowed[reason]; !ok {
			result.Errors = append(result.Errors, RecordError{
				Record: record,
				Err:    fmt.Errorf("%w: %q", ErrUnknownReason, reason),
			})
			continue
		}

		key := keyFor(record)
		if index, exists := deadLetterIndex[key]; exists {
			deadLetter := &result.DeadLetters[index]
			deadLetter.Reasons = append(deadLetter.Reasons, reason)
			deadLetter.ReasonCodes = append(deadLetter.ReasonCodes, reason)
			continue
		}

		deadLetterIndex[key] = len(result.DeadLetters)
		result.DeadLetters = append(result.DeadLetters, newDeadLetter(record, reason))
	}

	return result, result.Err()
}

func normalizeReasons(value any) (map[string]struct{}, error) {
	allowed := make(map[string]struct{})
	if value == nil {
		return allowed, nil
	}

	rv := reflect.ValueOf(value)
	for rv.Kind() == reflect.Pointer || rv.Kind() == reflect.Interface {
		if rv.IsNil() {
			return allowed, nil
		}
		rv = rv.Elem()
	}

	switch rv.Kind() {
	case reflect.Slice, reflect.Array:
		for i := 0; i < rv.Len(); i++ {
			element := rv.Index(i)
			if element.Kind() != reflect.String {
				return nil, fmt.Errorf("%w: element %d is %s, not string", ErrUnsupportedReasonList, i, element.Kind())
			}
			if reason := element.String(); reason != "" {
				allowed[reason] = struct{}{}
			}
		}
	case reflect.Map:
		iterator := rv.MapRange()
		for iterator.Next() {
			key := iterator.Key()
			if key.Kind() != reflect.String {
				return nil, fmt.Errorf("%w: key type %s is not string", ErrUnsupportedReasonList, key.Kind())
			}
			if reason := key.String(); reason != "" {
				allowed[reason] = struct{}{}
			}
		}
	case reflect.String:
		if reason := rv.String(); reason != "" {
			allowed[reason] = struct{}{}
		}
	default:
		return nil, fmt.Errorf("%w: %T", ErrUnsupportedReasonList, value)
	}

	return allowed, nil
}

func validateHandler(handler any) error {
	if handler == nil {
		return ErrNilHandler
	}
	rv := reflect.ValueOf(handler)
	if rv.Kind() != reflect.Func || rv.IsNil() {
		return fmt.Errorf("%w: %T", ErrUnsupportedHandler, handler)
	}
	handlerType := rv.Type()
	if handlerType.NumIn() != 1 {
		return fmt.Errorf("%w: handler takes %d arguments", ErrUnsupportedHandler, handlerType.NumIn())
	}
	recordType := reflect.TypeOf(Record{})
	if !recordType.AssignableTo(handlerType.In(0)) {
		return fmt.Errorf("%w: handler argument is %s", ErrUnsupportedHandler, handlerType.In(0))
	}

	switch handlerType.NumOut() {
	case 1:
		output := handlerType.Out(0)
		if output.Kind() == reflect.String || output == reflect.TypeOf((*error)(nil)).Elem() {
			return nil
		}
	case 2:
		first, second := handlerType.Out(0), handlerType.Out(1)
		if first.Kind() == reflect.String &&
			(second == reflect.TypeOf((*error)(nil)).Elem() || second.Kind() == reflect.Bool) {
			return nil
		}
		if first == reflect.TypeOf((*error)(nil)).Elem() && second.Kind() == reflect.String {
			return nil
		}
	}
	return fmt.Errorf("%w: handler returns %s", ErrUnsupportedHandler, handlerType)
}

func invokeHandler(handler any, record Record) (reason string, failed bool, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			reason = ""
			failed = true
			err = fmt.Errorf("handler panic: %v", recovered)
		}
	}()

	switch typed := handler.(type) {
	case Handler:
		return outcomeFromReasonAndError(typed(record))
	case ErrorHandler:
		return outcomeFromError(typed(record))
	case func(Record) (string, error):
		return outcomeFromReasonAndError(typed(record))
	case func(Record) error:
		return outcomeFromError(typed(record))
	case func(Record) string:
		reason = typed(record)
		return reason, reason != "", nil
	case func(Record) (string, bool):
		reason, ok := typed(record)
		return reason, !ok || reason != "", nil
	}

	return invokeHandlerByReflection(handler, record)
}

func outcomeFromReasonAndError(reason string, err error) (string, bool, error) {
	if reason == "" {
		reason = reasonFromError(err)
	}
	return reason, err != nil || reason != "", err
}

func outcomeFromError(err error) (string, bool, error) {
	if err == nil {
		return "", false, nil
	}
	return reasonFromError(err), true, err
}

func reasonFromError(err error) string {
	var reasonErr *ReasonError
	if errors.As(err, &reasonErr) {
		return reasonErr.Code
	}
	return ""
}

func invokeHandlerByReflection(handler any, record Record) (reason string, failed bool, err error) {
	rv := reflect.ValueOf(handler)
	outputs := rv.Call([]reflect.Value{reflect.ValueOf(record)})

	switch len(outputs) {
	case 1:
		output := outputs[0]
		if output.Type() == reflect.TypeOf((*error)(nil)).Elem() {
			var handlerErr error
			if !output.IsNil() {
				handlerErr = output.Interface().(error)
			}
			return outcomeFromError(handlerErr)
		}
		return output.String(), output.String() != "", nil
	case 2:
		first, second := outputs[0], outputs[1]
		if first.Kind() == reflect.String {
			reason = first.String()
			if second.Kind() == reflect.Bool {
				return reason, !second.Bool() || reason != "", nil
			}
			var handlerErr error
			if !second.IsNil() {
				handlerErr = second.Interface().(error)
			}
			return outcomeFromReasonAndError(reason, handlerErr)
		}

		var handlerErr error
		if !first.IsNil() {
			handlerErr = first.Interface().(error)
		}
		return outcomeFromReasonAndError(second.String(), handlerErr)
	}

	return "", true, fmt.Errorf("%w: handler returned %d values", ErrUnsupportedHandler, len(outputs))
}
