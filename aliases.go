package dataeng

// Batch is the record slice accepted by the batch helpers.
type Batch = []Record

// DLQ is the dead-letter slice returned by the slice-oriented helpers.
type DLQ = []DeadLetter

// Result is an alias for BatchResult.
type Result = BatchResult

// Delivery is an alias for BatchResult.
type Delivery = BatchResult

// FailedRecord is an alias for DeadLetter.
type FailedRecord = DeadLetter

// DeadLetterRecord is an alias for DeadLetter.
type DeadLetterRecord = DeadLetter

// RouteBatch is the same operation as ProcessBatch.
func RouteBatch(records []Record, allowedReasons any, handler any) (delivered []Record, deadLetters []DeadLetter, err error) {
	return ProcessBatch(records, allowedReasons, handler)
}

// IsolateFailures is the same operation as ProcessBatch.
func IsolateFailures(records []Record, allowedReasons any, handler any) (delivered []Record, deadLetters []DeadLetter, err error) {
	return ProcessBatch(records, allowedReasons, handler)
}

// Isolate is the same operation as ProcessBatch.
func Isolate(records []Record, allowedReasons any, handler any) (delivered []Record, deadLetters []DeadLetter, err error) {
	return ProcessBatch(records, allowedReasons, handler)
}

// SplitBatch is the same operation as ProcessBatch.
func SplitBatch(records []Record, allowedReasons any, handler any) (delivered []Record, deadLetters []DeadLetter, err error) {
	return ProcessBatch(records, allowedReasons, handler)
}

// RunBatch is the result-oriented form of Process.
func RunBatch(records []Record, allowedReasons any, handler any) (BatchResult, error) {
	return Process(records, allowedReasons, handler)
}

// HandleBatch is the result-oriented form of Process.
func HandleBatch(records []Record, allowedReasons any, handler any) (BatchResult, error) {
	return Process(records, allowedReasons, handler)
}

// DeliverBatch is the result-oriented form of Process.
func DeliverBatch(records []Record, allowedReasons any, handler any) (BatchResult, error) {
	return Process(records, allowedReasons, handler)
}

// ProcessRecords is the result-oriented form of Process.
func ProcessRecords(records []Record, allowedReasons any, handler any) (BatchResult, error) {
	return Process(records, allowedReasons, handler)
}
