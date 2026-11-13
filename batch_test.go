package dataeng_test

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"example.org/dataeng13/q0045"
)

func classify(record dataeng.Record) (string, error) {
	payload := string(record.Payload)
	switch {
	case strings.HasPrefix(payload, "ok-"):
		return "", nil
	case strings.HasPrefix(payload, "bad-json"):
		return "invalid_json", errors.New("payload is not valid JSON")
	case strings.HasPrefix(payload, "bad-schema"):
		return "schema_error", errors.New("payload does not match schema")
	default:
		return "unclassified", errors.New("unexpected payload")
	}
}

func TestProcessBatchPartialFailureAndRepeatedOffset(t *testing.T) {
	records := []dataeng.Record{
		{Partition: 0, Offset: 0, Payload: []byte("ok-0")},
		{Partition: 0, Offset: 1, Payload: []byte("bad-json-1")},
		{Partition: 1, Offset: 2, Payload: []byte("ok-2")},
		{Partition: 0, Offset: 1, Payload: []byte("bad-schema-1b")},
		{Partition: 2, Offset: 3, Payload: []byte("bad-json-3")},
		{Partition: 2, Offset: 4, Payload: []byte("ok-4")},
	}

	delivered, deadLetters, err := dataeng.ProcessBatch(
		records,
		[]string{"invalid_json", "schema_error"},
		classify,
	)
	if err != nil {
		t.Fatalf("ProcessBatch returned an unexpected error: %v", err)
	}

	wantDelivered := []dataeng.Record{
		{Partition: 0, Offset: 0, Payload: []byte("ok-0")},
		{Partition: 1, Offset: 2, Payload: []byte("ok-2")},
		{Partition: 2, Offset: 4, Payload: []byte("ok-4")},
	}
	if !reflect.DeepEqual(delivered, wantDelivered) {
		t.Fatalf("delivered records:\n got: %#v\nwant: %#v", delivered, wantDelivered)
	}

	wantDeadLetters := []dataeng.DeadLetter{
		{
			Partition:   0,
			Offset:      1,
			Payload:     []byte("bad-json-1"),
			Reason:      "invalid_json",
			Reasons:     []string{"invalid_json", "schema_error"},
			ReasonCode:  "invalid_json",
			ReasonCodes: []string{"invalid_json", "schema_error"},
		},
		{
			Partition:   2,
			Offset:      3,
			Payload:     []byte("bad-json-3"),
			Reason:      "invalid_json",
			Reasons:     []string{"invalid_json"},
			ReasonCode:  "invalid_json",
			ReasonCodes: []string{"invalid_json"},
		},
	}
	if !reflect.DeepEqual(deadLetters, wantDeadLetters) {
		t.Fatalf("dead letters:\n got: %#v\nwant: %#v", deadLetters, wantDeadLetters)
	}
}

func TestProcessBatchRepeatedSameReasonKeepsFirstAndAppends(t *testing.T) {
	records := []dataeng.Record{
		{Partition: 7, Offset: 41, Payload: []byte("bad-json-a")},
		{Partition: 7, Offset: 41, Payload: []byte("bad-json-b")},
	}

	delivered, deadLetters, err := dataeng.ProcessBatch(
		records,
		dataeng.ReasonSet{"invalid_json": {}},
		classify,
	)
	if err != nil {
		t.Fatalf("ProcessBatch returned an unexpected error: %v", err)
	}
	if len(delivered) != 0 {
		t.Fatalf("got %d delivered records, want 0", len(delivered))
	}
	if len(deadLetters) != 1 {
		t.Fatalf("got %d dead letters, want 1", len(deadLetters))
	}

	want := dataeng.DeadLetter{
		Partition:   7,
		Offset:      41,
		Payload:     []byte("bad-json-a"),
		Reason:      "invalid_json",
		Reasons:     []string{"invalid_json", "invalid_json"},
		ReasonCode:  "invalid_json",
		ReasonCodes: []string{"invalid_json", "invalid_json"},
	}
	if !reflect.DeepEqual(deadLetters[0], want) {
		t.Fatalf("dead letter:\n got: %#v\nwant: %#v", deadLetters[0], want)
	}
	if deadLetters[0].FirstReason() != "invalid_json" {
		t.Fatalf("FirstReason() = %q, want %q", deadLetters[0].FirstReason(), "invalid_json")
	}
}

func TestProcessBatchUnknownReasonDoesNotRollBackSuccesses(t *testing.T) {
	records := []dataeng.Record{
		{Partition: 3, Offset: 10, Payload: []byte("ok-a")},
		{Partition: 3, Offset: 11, Payload: []byte("bad-unknown")},
		{Partition: 3, Offset: 12, Payload: []byte("ok-b")},
	}

	delivered, deadLetters, err := dataeng.ProcessBatch(
		records,
		[]string{"invalid_json"},
		classify,
	)
	if err == nil {
		t.Fatal("ProcessBatch returned nil error for an out-of-list reason")
	}
	if !errors.Is(err, dataeng.ErrUnknownReason) {
		t.Fatalf("error = %v, want ErrUnknownReason", err)
	}
	if !strings.Contains(err.Error(), "partition 3 offset 11") {
		t.Fatalf("error does not identify the failing coordinate: %v", err)
	}

	wantDelivered := []dataeng.Record{
		{Partition: 3, Offset: 10, Payload: []byte("ok-a")},
		{Partition: 3, Offset: 12, Payload: []byte("ok-b")},
	}
	if !reflect.DeepEqual(delivered, wantDelivered) {
		t.Fatalf("delivered records:\n got: %#v\nwant: %#v", delivered, wantDelivered)
	}
	if len(deadLetters) != 0 {
		t.Fatalf("got %d dead letters, want 0", len(deadLetters))
	}
}

func TestProcessPreservesPayloadAgainstHandlerMutation(t *testing.T) {
	records := []dataeng.Record{
		{Partition: 5, Offset: 20, Payload: []byte("ok-original")},
		{Partition: 5, Offset: 21, Payload: []byte("bad-json-original")},
	}

	mutating := func(record dataeng.Record) (string, error) {
		if len(record.Payload) != 0 {
			record.Payload[0] = 'X'
		}
		if strings.HasPrefix(string(record.Payload), "Xad-json") {
			return "invalid_json", errors.New("bad JSON")
		}
		return "", nil
	}

	delivered, deadLetters, err := dataeng.ProcessBatch(
		records,
		[]string{"invalid_json"},
		mutating,
	)
	if err != nil {
		t.Fatalf("Process returned an unexpected error: %v", err)
	}
	if len(delivered) != 1 || string(delivered[0].Payload) != "ok-original" {
		t.Fatalf("delivered payload was not preserved: %#v", delivered)
	}
	if len(deadLetters) != 1 || string(deadLetters[0].Payload) != "bad-json-original" {
		t.Fatalf("dead-letter payload was not preserved: %#v", deadLetters)
	}
}

func TestProcessBatchMissingReasonIsReportedButBatchContinues(t *testing.T) {
	records := []dataeng.Record{
		{Partition: 9, Offset: 30, Payload: []byte("ok-first")},
		{Partition: 9, Offset: 31, Payload: []byte("bad-json-no-reason")},
		{Partition: 9, Offset: 32, Payload: []byte("ok-last")},
	}

	handler := func(record dataeng.Record) (string, error) {
		if strings.HasPrefix(string(record.Payload), "bad-json") {
			return "", errors.New("failure without a reason")
		}
		return "", nil
	}

	delivered, deadLetters, err := dataeng.ProcessBatch(records, nil, handler)
	if !errors.Is(err, dataeng.ErrMissingReason) {
		t.Fatalf("error = %v, want ErrMissingReason", err)
	}
	if len(delivered) != 2 || len(deadLetters) != 0 {
		t.Fatalf("got %d delivered, %d dead letters; want 2 and 0", len(delivered), len(deadLetters))
	}
}

func TestProcessUsesReasonErrorAndAllowedMap(t *testing.T) {
	records := []dataeng.Record{
		{Partition: 4, Offset: 50, Payload: []byte("bad-json")},
		{Partition: 4, Offset: 51, Payload: []byte("ok")},
	}

	handler := dataeng.ErrorHandler(func(record dataeng.Record) error {
		if strings.HasPrefix(string(record.Payload), "bad-json") {
			return &dataeng.ReasonError{Code: "invalid_json", Err: errors.New("bad JSON")}
		}
		return nil
	})

	result, err := dataeng.Process(
		records,
		map[string]bool{"invalid_json": true},
		handler,
	)
	if err != nil {
		t.Fatalf("Process returned an unexpected error: %v", err)
	}
	if len(result.Delivered) != 1 || string(result.Delivered[0].Payload) != "ok" {
		t.Fatalf("unexpected delivered records: %#v", result.Delivered)
	}
	if len(result.DeadLetters) != 1 || result.DeadLetters[0].FirstReason() != "invalid_json" {
		t.Fatalf("unexpected dead letters: %#v", result.DeadLetters)
	}
}

func TestHandlerPanicDoesNotAbortBatch(t *testing.T) {
	records := []dataeng.Record{
		{Partition: 8, Offset: 60, Payload: []byte("panic")},
		{Partition: 8, Offset: 61, Payload: []byte("ok-after-panic")},
	}

	handler := func(record dataeng.Record) (string, error) {
		if string(record.Payload) == "panic" {
			panic("boom")
		}
		return "", nil
	}

	delivered, deadLetters, err := dataeng.ProcessBatch(records, nil, handler)
	if err == nil {
		t.Fatal("ProcessBatch returned nil error for a handler panic")
	}
	if len(delivered) != 1 || string(delivered[0].Payload) != "ok-after-panic" {
		t.Fatalf("panic rolled back the following record: %#v", delivered)
	}
	if len(deadLetters) != 0 {
		t.Fatalf("got %d dead letters, want 0", len(deadLetters))
	}
}

func TestProcessorReusesAllowedReasons(t *testing.T) {
	processor := dataeng.NewProcessor(dataeng.ReasonList{"invalid_json"})

	result, err := processor.Process(
		[]dataeng.Record{{Partition: 6, Offset: 70, Payload: []byte("bad-json")}},
		classify,
	)
	if err != nil {
		t.Fatalf("Processor.Process returned an unexpected error: %v", err)
	}
	if len(result.DeadLetters) != 1 {
		t.Fatalf("got %d dead letters, want 1", len(result.DeadLetters))
	}
	if !result.DeadLetters[0].Equal(dataeng.DeadLetter{
		Partition: 6,
		Offset:    70,
		Payload:   []byte("bad-json"),
		Reason:    "invalid_json",
	}) {
		t.Fatalf("dead letter does not match the semantic expectation: %#v", result.DeadLetters[0])
	}
}

func TestSameOffsetInDifferentPartitionsIsNotMerged(t *testing.T) {
	records := []dataeng.Record{
		{Partition: 0, Offset: 80, Payload: []byte("bad-json")},
		{Partition: 1, Offset: 80, Payload: []byte("bad-schema")},
	}

	_, deadLetters, err := dataeng.ProcessBatch(
		records,
		[]string{"invalid_json", "schema_error"},
		classify,
	)
	if err != nil {
		t.Fatalf("ProcessBatch returned an unexpected error: %v", err)
	}
	if len(deadLetters) != 2 {
		t.Fatalf("got %d dead letters, want 2", len(deadLetters))
	}
	if deadLetters[0].Partition != 0 || deadLetters[1].Partition != 1 {
		t.Fatalf("partition coordinates were not preserved: %#v", deadLetters)
	}
	if deadLetters[0].FirstReason() != "invalid_json" || deadLetters[1].FirstReason() != "schema_error" {
		t.Fatalf("unexpected reasons: %#v", deadLetters)
	}
}
