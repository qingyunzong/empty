package q204

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestProcessNestedSensitiveFieldsArraysAndEmptyArrays(t *testing.T) {
	key := []byte("tenant-key-1")
	event := map[string]any{
		"users": []any{
			map[string]any{
				"name": "Alice",
				"profile": map[string]any{
					"email": "alice@example.com",
					"ssn":   "111-11-1111",
					"note":  "keep",
				},
			},
			map[string]any{
				"name": "张三",
				"profile": map[string]any{
					"email": "zhangsan@example.com",
					"ssn":   "222-22-2222",
					"note":  "keep",
				},
			},
		},
		"meta": map[string]any{
			"tags":  []any{"alpha", "beta"},
			"empty": []any{},
		},
	}
	original := cloneValue(event)

	processor := New(newInjectedStore(key))
	batch, err := processor.StartBatch(context.Background(), BatchRequest{
		ID: "nested-batch",
		Rules: []Rule{
			{Path: []string{"users", "*", "profile", "email"}, Action: Action{Type: ActionHMAC}},
			{Path: []string{"users", "*", "profile", "ssn"}, Action: Action{Type: ActionDelete}},
			{Path: []string{"users", "*", "name"}, Action: Action{Type: ActionReplace, Replacement: "<redacted>"}},
			{Path: []string{"meta", "tags"}, Action: Action{Type: ActionHMAC}},
			{Path: []string{"meta", "empty"}, Action: Action{Type: ActionHMAC}},
		},
		Events: []Event{event},
	})
	if err != nil {
		t.Fatalf("StartBatch failed: %v", err)
	}

	result, err := batch.Process(context.Background())
	if err != nil {
		t.Fatalf("Process failed: %v", err)
	}
	got := result[0].(map[string]any)
	users := got["users"].([]any)
	for i, userValue := range users {
		user := userValue.(map[string]any)
		if user["name"] != "<redacted>" {
			t.Fatalf("users[%d].name = %v", i, user["name"])
		}
		profile := user["profile"].(map[string]any)
		if _, ok := profile["ssn"]; ok {
			t.Fatalf("users[%d].profile.ssn was not deleted", i)
		}
		email, _ := profile["email"].(string)
		if len(email) != 64 || strings.ToLower(email) != email {
			t.Fatalf("users[%d].profile.email is not a lowercase HMAC hex: %q", i, email)
		}
		if profile["note"] != "keep" {
			t.Fatalf("users[%d].profile.note was modified", i)
		}
	}
	if got["users"].([]any)[0].(map[string]any)["profile"].(map[string]any)["email"] != referenceHMAC(key, "alice@example.com") {
		t.Fatal("email HMAC does not cover UTF-8 bytes with the batch key")
	}
	if got["users"].([]any)[1].(map[string]any)["profile"].(map[string]any)["email"] != referenceHMAC(key, "zhangsan@example.com") {
		t.Fatal("non-ASCII email was not hashed over UTF-8 bytes")
	}

	tags := got["meta"].(map[string]any)["tags"].([]any)
	if len(tags) != 2 || tags[0] != referenceHMAC(key, "alpha") || tags[1] != referenceHMAC(key, "beta") {
		t.Fatalf("tags were not matched element-wise: %#v", tags)
	}
	empty, ok := got["meta"].(map[string]any)["empty"].([]any)
	if !ok || len(empty) != 0 {
		t.Fatalf("empty array changed or failed: %#v", got["meta"])
	}

	if !reflect.DeepEqual(event, original) {
		t.Fatal("submitted event was mutated")
	}
}

func TestArraysAreTransparentForLiteralPaths(t *testing.T) {
	key := []byte("array-key")
	event := map[string]any{
		"items": []any{
			map[string]any{"email": "one@example.com"},
			map[string]any{"email": "two@example.com"},
		},
	}
	batch, err := New(newInjectedStore(key)).StartBatch(context.Background(), BatchRequest{
		Rules:  []Rule{{Path: []string{"items", "email"}, Action: Action{Type: ActionHMAC}}},
		Events: []Event{event},
	})
	if err != nil {
		t.Fatalf("StartBatch failed: %v", err)
	}
	result, err := batch.Process(context.Background())
	if err != nil {
		t.Fatalf("Process failed: %v", err)
	}
	items := result[0].(map[string]any)["items"].([]any)
	for i, itemValue := range items {
		email := itemValue.(map[string]any)["email"]
		if email != referenceHMAC(key, []string{"one@example.com", "two@example.com"}[i]) {
			t.Fatalf("items[%d].email = %v", i, email)
		}
	}
}

func TestDeleteAndReplaceArrayElements(t *testing.T) {
	rules := []Rule{
		{Path: []string{"delete_me"}, Action: Action{Type: ActionDelete}},
		{Path: []string{"replace_me"}, Action: Action{Type: ActionReplace, Replacement: "<redacted>"}},
	}
	batch, err := New(nil).StartBatch(context.Background(), BatchRequest{
		Rules: rules,
		Events: []Event{map[string]any{
			"delete_me":  []any{"a", "b"},
			"replace_me": []any{"a", "b"},
			"untouched":  []any{},
		}},
	})
	if err != nil {
		t.Fatalf("StartBatch failed: %v", err)
	}
	result, err := batch.Process(context.Background())
	if err != nil {
		t.Fatalf("Process failed: %v", err)
	}
	got := result[0].(map[string]any)
	if array := got["delete_me"].([]any); len(array) != 0 {
		t.Fatalf("delete_me = %#v, want empty array", array)
	}
	replaced := got["replace_me"].([]any)
	if len(replaced) != 2 || replaced[0] != "<redacted>" || replaced[1] != "<redacted>" {
		t.Fatalf("replace_me = %#v", replaced)
	}
	if !reflect.DeepEqual(got["untouched"], []any{}) {
		t.Fatalf("empty untouched array changed: %#v", got["untouched"])
	}
}

func TestReplacementIsNotMatchedAgain(t *testing.T) {
	key := []byte("replacement-key")
	batch, err := New(newInjectedStore(key)).StartBatch(context.Background(), BatchRequest{
		Rules: []Rule{
			{Path: []string{"replacement"}, Action: Action{Type: ActionReplace, Replacement: "<redacted>"}},
			{Path: []string{"*"}, Action: Action{Type: ActionHMAC}},
		},
		Events: []Event{map[string]any{
			"replacement": "raw-secret",
			"other":       "another-secret",
		}},
	})
	if err != nil {
		t.Fatalf("StartBatch failed: %v", err)
	}
	result, err := batch.Process(context.Background())
	if err != nil {
		t.Fatalf("Process failed: %v", err)
	}
	got := result[0].(map[string]any)
	if got["replacement"] != "<redacted>" {
		t.Fatalf("replacement = %v, want <redacted>", got["replacement"])
	}
	if got["other"] != referenceHMAC(key, "another-secret") {
		t.Fatalf("other = %v, want HMAC", got["other"])
	}
}

func TestNonStringHMACRejectsWholeBatchWithoutLeakingValue(t *testing.T) {
	key := []byte("strict-key")
	original := map[string]any{
		"secret": "first-secret-value",
		"other":  "must-not-be-returned",
	}
	batch, err := New(newInjectedStore(key)).StartBatch(context.Background(), BatchRequest{
		ID:     "reject-batch",
		Rules:  []Rule{{Path: []string{"secret"}, Action: Action{Type: ActionHMAC}}},
		Events: []Event{original, map[string]any{"secret": map[string]any{"nested": "raw"}}},
	})
	if err != nil {
		t.Fatalf("StartBatch failed: %v", err)
	}

	result, err := batch.Process(context.Background())
	if result != nil {
		t.Fatalf("partial result returned: %#v", result)
	}
	if !errors.Is(err, ErrNonStringHMAC) {
		t.Fatalf("error = %v, want ErrNonStringHMAC", err)
	}
	var valueErr *ValueTypeError
	if !errors.As(err, &valueErr) {
		t.Fatalf("error = %v, want ValueTypeError", err)
	}
	if strings.Contains(err.Error(), "first-secret-value") || strings.Contains(err.Error(), "must-not-be-returned") {
		t.Fatalf("error leaked a raw event value: %v", err)
	}
	if !reflect.DeepEqual(original, map[string]any{
		"secret": "first-secret-value",
		"other":  "must-not-be-returned",
	}) {
		t.Fatal("submitted event was mutated after batch rejection")
	}
	if _, retryErr := batch.Retry(context.Background()); !errors.Is(retryErr, ErrNonStringHMAC) {
		t.Fatalf("Retry error = %v, want ErrNonStringHMAC", retryErr)
	}
}

func TestNilAndEmptyArraysWithHMAC(t *testing.T) {
	batch, err := New(newInjectedStore([]byte("key"))).StartBatch(context.Background(), BatchRequest{
		Rules:  []Rule{{Path: []string{"empty"}, Action: Action{Type: ActionHMAC}}},
		Events: []Event{map[string]any{"empty": []any{}}},
	})
	if err != nil {
		t.Fatalf("StartBatch failed: %v", err)
	}
	result, err := batch.Process(context.Background())
	if err != nil {
		t.Fatalf("empty array should not be a non-string HMAC hit: %v", err)
	}
	empty := result[0].(map[string]any)["empty"].([]any)
	if len(empty) != 0 {
		t.Fatalf("empty array changed: %#v", empty)
	}
}

func TestNonStringHMACIncludesNumbersAndNil(t *testing.T) {
	for _, value := range []any{int64(42), 3.5, true, nil, map[string]any{}} {
		batch, err := New(newInjectedStore([]byte("key"))).StartBatch(context.Background(), BatchRequest{
			Rules:  []Rule{{Path: []string{"secret"}, Action: Action{Type: ActionHMAC}}},
			Events: []Event{map[string]any{"secret": value}},
		})
		if err != nil {
			t.Fatalf("StartBatch failed: %v", err)
		}
		if _, err := batch.Process(context.Background()); !errors.Is(err, ErrNonStringHMAC) {
			t.Fatalf("value %#v error = %v, want ErrNonStringHMAC", value, err)
		}
	}
}

func TestDeleteAndReplaceNonStringValues(t *testing.T) {
	batch, err := New(nil).StartBatch(context.Background(), BatchRequest{
		Rules: []Rule{
			{Path: []string{"count"}, Action: Action{Type: ActionDelete}},
			{Path: []string{"flag"}, Action: Action{Type: ActionReplace, Replacement: "<redacted>"}},
		},
		Events: []Event{map[string]any{"count": 42, "flag": true}},
	})
	if err != nil {
		t.Fatalf("StartBatch failed: %v", err)
	}
	result, err := batch.Process(context.Background())
	if err != nil {
		t.Fatalf("Process failed: %v", err)
	}
	got := result[0].(map[string]any)
	if _, ok := got["count"]; ok {
		t.Fatal("numeric value was not deleted")
	}
	if got["flag"] != "<redacted>" {
		t.Fatalf("boolean flag = %v, want replacement", got["flag"])
	}
}

func TestEventSnapshotIsUsedByRetries(t *testing.T) {
	event := map[string]any{
		"secret": "snapshot-value",
		"nested": map[string]any{"secret": "nested-value"},
	}
	batch, err := New(newInjectedStore([]byte("snapshot-key"))).StartBatch(context.Background(), BatchRequest{
		Rules: []Rule{
			{Path: []string{"secret"}, Action: Action{Type: ActionDelete}},
			{Path: []string{"nested", "secret"}, Action: Action{Type: ActionDelete}},
		},
		Events: []Event{event},
	})
	if err != nil {
		t.Fatalf("StartBatch failed: %v", err)
	}
	event["secret"] = "caller-mutation"
	event["nested"].(map[string]any)["secret"] = "caller-nested-mutation"

	result, err := batch.Process(context.Background())
	if err != nil {
		t.Fatalf("Process failed: %v", err)
	}
	got := result[0].(map[string]any)
	if _, ok := got["secret"]; ok {
		t.Fatal("caller mutation affected the batch snapshot")
	}
	if _, ok := got["nested"].(map[string]any)["secret"]; ok {
		t.Fatal("caller nested mutation affected the batch snapshot")
	}
}
