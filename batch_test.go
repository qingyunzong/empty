package q204

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestKeyRotationOnlyAffectsNewBatches(t *testing.T) {
	store := newInjectedStore([]byte("key-version-1"))
	processor := New(store)
	request := BatchRequest{
		ID:     "old-batch",
		Rules:  []Rule{{Path: []string{"secret"}, Action: Action{Type: ActionHMAC}}},
		Events: []Event{map[string]any{"secret": "raw-secret"}},
	}

	oldBatch, err := processor.StartBatch(context.Background(), request)
	if err != nil {
		t.Fatalf("StartBatch old failed: %v", err)
	}
	first, err := oldBatch.Process(context.Background())
	if err != nil {
		t.Fatalf("Process old failed: %v", err)
	}
	expectedOld := referenceHMAC([]byte("key-version-1"), "raw-secret")
	if secret := first[0].(map[string]any)["secret"]; secret != expectedOld {
		t.Fatalf("old batch secret = %v, want %s", secret, expectedOld)
	}
	beforeCurrent, beforeLoad := store.Counts()

	store.Rotate([]byte("key-version-2"))
	retried, err := oldBatch.Retry(context.Background())
	if err != nil {
		t.Fatalf("Retry old failed: %v", err)
	}
	if secret := retried[0].(map[string]any)["secret"]; secret != expectedOld {
		t.Fatalf("retry secret = %v, want original bytes %s", secret, expectedOld)
	}
	afterCurrent, afterLoad := store.Counts()
	if afterCurrent != beforeCurrent || afterLoad != beforeLoad {
		t.Fatalf("retry read the keystore: current %d->%d load %d->%d", beforeCurrent, afterCurrent, beforeLoad, afterLoad)
	}

	request.ID = "new-batch"
	newBatch, err := processor.StartBatch(context.Background(), request)
	if err != nil {
		t.Fatalf("StartBatch new failed: %v", err)
	}
	newResult, err := newBatch.Process(context.Background())
	if err != nil {
		t.Fatalf("Process new failed: %v", err)
	}
	expectedNew := referenceHMAC([]byte("key-version-2"), "raw-secret")
	if secret := newResult[0].(map[string]any)["secret"]; secret != expectedNew {
		t.Fatalf("new batch secret = %v, want %s", secret, expectedNew)
	}
	if expectedOld == expectedNew {
		t.Fatal("test keys produced the same HMAC")
	}
}

func TestRotationRetryRaceKeepsOldBatchBytes(t *testing.T) {
	store := newInjectedStore([]byte("initial-key"))
	processor := New(store)
	batch, err := processor.StartBatch(context.Background(), BatchRequest{
		ID:     "race-batch",
		Rules:  []Rule{{Path: []string{"secret"}, Action: Action{Type: ActionHMAC}}},
		Events: []Event{map[string]any{"secret": "race-secret"}},
	})
	if err != nil {
		t.Fatalf("StartBatch failed: %v", err)
	}
	expected := referenceHMAC([]byte("initial-key"), "race-secret")

	var wg sync.WaitGroup
	errs := make(chan error, 64)
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 10; j++ {
				result, retryErr := batch.Retry(context.Background())
				if retryErr != nil {
					errs <- retryErr
					return
				}
				if secret := result[0].(map[string]any)["secret"]; secret != expected {
					errs <- fmt.Errorf("retry produced %v, want %s", secret, expected)
					return
				}
			}
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 50; i++ {
			store.Rotate([]byte(fmt.Sprintf("rotated-key-%d", i)))
		}
	}()
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}

	ref := store.CurrentRef()
	request := BatchRequest{
		Rules:  []Rule{{Path: []string{"secret"}, Action: Action{Type: ActionHMAC}}},
		Events: []Event{map[string]any{"secret": "race-secret"}},
	}
	newBatch, err := processor.StartBatch(context.Background(), request)
	if err != nil {
		t.Fatalf("StartBatch after rotation failed: %v", err)
	}
	result, err := newBatch.Process(context.Background())
	if err != nil {
		t.Fatalf("Process after rotation failed: %v", err)
	}
	if secret := result[0].(map[string]any)["secret"]; secret != referenceHMAC(store.Key(ref), "race-secret") {
		t.Fatal("new batch did not use the rotated key")
	}
}

func TestRevokeClearsKeyReferenceAndStopsReads(t *testing.T) {
	store := newInjectedStore([]byte("revoke-key"))
	batch, err := New(store).StartBatch(context.Background(), BatchRequest{
		ID:     "revoke-batch",
		Rules:  []Rule{{Path: []string{"secret"}, Action: Action{Type: ActionHMAC}}},
		Events: []Event{map[string]any{"secret": "raw-secret"}},
	})
	if err != nil {
		t.Fatalf("StartBatch failed: %v", err)
	}
	if _, err := batch.Process(context.Background()); err != nil {
		t.Fatalf("Process failed: %v", err)
	}

	keyAlias := batch.key
	_, loadsBefore := store.Counts()
	if err := batch.Revoke(context.Background()); err != nil {
		t.Fatalf("Revoke failed: %v", err)
	}
	if !batch.Revoked() {
		t.Fatal("batch is not marked revoked")
	}
	if !batch.keyRef.IsZero() || batch.key != nil || batch.events != nil {
		t.Fatalf("revoke retained key ref=%v key=%v events=%v", batch.keyRef, batch.key, batch.events != nil)
	}
	for i, b := range keyAlias {
		if b != 0 {
			t.Fatalf("key byte %d was not cleared", i)
		}
	}
	_, loadsAfter := store.Counts()
	if loadsAfter != loadsBefore {
		t.Fatalf("revocation read the key again: loads %d->%d", loadsBefore, loadsAfter)
	}
	if _, err := batch.Process(context.Background()); !errors.Is(err, ErrBatchRevoked) {
		t.Fatalf("Process after revoke = %v, want ErrBatchRevoked", err)
	}
	if _, err := batch.Retry(context.Background()); !errors.Is(err, ErrBatchRevoked) {
		t.Fatalf("Retry after revoke = %v, want ErrBatchRevoked", err)
	}
	_, loadsFinal := store.Counts()
	if loadsFinal != loadsBefore {
		t.Fatalf("process after revoke read the key: loads %d->%d", loadsBefore, loadsFinal)
	}

	batches, refs := store.Revocations()
	if len(batches) != 1 || batches[0] != "revoke-batch" {
		t.Fatalf("revoker calls = %#v", batches)
	}
	if len(refs) != 1 || refs[0].IsZero() {
		t.Fatalf("revoked refs = %#v", refs)
	}
	if err := batch.Revoke(context.Background()); err != nil {
		t.Fatalf("second Revoke should be idempotent: %v", err)
	}
}

func TestRevokeKeepsBatchInvalidWhenStoreFails(t *testing.T) {
	store := newInjectedStore([]byte("failure-key"))
	store.SetRevokeError(errInjectedStore)
	batch, err := New(store).StartBatch(context.Background(), BatchRequest{
		ID:     "failure-batch",
		Rules:  []Rule{{Path: []string{"secret"}, Action: Action{Type: ActionHMAC}}},
		Events: []Event{map[string]any{"secret": "failure-secret"}},
	})
	if err != nil {
		t.Fatalf("StartBatch failed: %v", err)
	}
	_, loadsBefore := store.Counts()

	revokeErr := batch.Revoke(context.Background())
	if !errors.Is(revokeErr, errInjectedStore) {
		t.Fatalf("Revoke error = %v, want injected store error", revokeErr)
	}
	if !batch.Revoked() {
		t.Fatal("batch must remain revoked after store failure")
	}
	if !batch.keyRef.IsZero() || batch.key != nil || batch.events != nil {
		t.Fatal("store failure retained local key material")
	}
	_, loadsAfter := store.Counts()
	if loadsAfter != loadsBefore {
		t.Fatalf("store failure caused another key read: %d->%d", loadsBefore, loadsAfter)
	}
	if _, err := batch.Process(context.Background()); !errors.Is(err, ErrBatchRevoked) {
		t.Fatalf("Process after failed revoke = %v, want ErrBatchRevoked", err)
	}
	if err := batch.Revoke(context.Background()); !errors.Is(err, errInjectedStore) {
		t.Fatalf("second Revoke = %v, want stored failure", err)
	}
}

func TestRevokeDuringProcessingFailsClosed(t *testing.T) {
	store := newInjectedStore([]byte("race-revoke-key"))
	const eventCount = 100000
	events := make([]Event, eventCount)
	for i := range events {
		events[i] = map[string]any{"secret": fmt.Sprintf("value-%d", i)}
	}
	batch, err := New(store).StartBatch(context.Background(), BatchRequest{
		ID:     "revoke-race-batch",
		Rules:  []Rule{{Path: []string{"secret"}, Action: Action{Type: ActionHMAC}}},
		Events: events,
	})
	if err != nil {
		t.Fatalf("StartBatch failed: %v", err)
	}

	done := make(chan error, 1)
	go func() {
		_, processErr := batch.Process(context.Background())
		done <- processErr
	}()
	time.Sleep(2 * time.Millisecond)
	if err := batch.Revoke(context.Background()); err != nil {
		t.Fatalf("Revoke failed: %v", err)
	}
	processErr := <-done
	if processErr != nil && !errors.Is(processErr, ErrBatchRevoked) {
		t.Fatalf("concurrent process error = %v, want ErrBatchRevoked", processErr)
	}
	if _, err := batch.Retry(context.Background()); !errors.Is(err, ErrBatchRevoked) {
		t.Fatalf("Retry after concurrent revoke = %v, want ErrBatchRevoked", err)
	}
}

func TestBatchStoreRevokerFallback(t *testing.T) {
	store := &keyOnlyRevoker{store: newInjectedStore([]byte("fallback-key"))}
	batch, err := New(store).StartBatch(context.Background(), BatchRequest{
		Rules:  []Rule{{Path: []string{"secret"}, Action: Action{Type: ActionHMAC}}},
		Events: []Event{map[string]any{"secret": "raw"}},
	})
	if err != nil {
		t.Fatalf("StartBatch failed: %v", err)
	}
	if err := batch.Revoke(context.Background()); err != nil {
		t.Fatalf("Revoke failed: %v", err)
	}
	if len(store.revokedKeys) != 1 {
		t.Fatalf("fallback revoker calls = %#v", store.revokedKeys)
	}
}

type keyOnlyRevoker struct {
	store       *injectedStore
	revokedKeys []KeyRef
}

func (s *keyOnlyRevoker) Current(ctx context.Context) (KeyRef, error) {
	return s.store.Current(ctx)
}

func (s *keyOnlyRevoker) Load(ctx context.Context, ref KeyRef) ([]byte, error) {
	return s.store.Load(ctx, ref)
}

func (s *keyOnlyRevoker) RevokeKey(_ context.Context, ref KeyRef) error {
	s.revokedKeys = append(s.revokedKeys, ref)
	return nil
}

func TestHMACResultLengthAndUnicode(t *testing.T) {
	key := []byte("unicode-key")
	secret := "用户邮箱@example.com"
	batch, err := New(newInjectedStore(key)).StartBatch(context.Background(), BatchRequest{
		Rules:  []Rule{{Path: []string{"secret"}, Action: Action{Type: ActionHMAC}}},
		Events: []Event{map[string]any{"secret": secret}},
	})
	if err != nil {
		t.Fatalf("StartBatch failed: %v", err)
	}
	result, err := batch.Process(context.Background())
	if err != nil {
		t.Fatalf("Process failed: %v", err)
	}
	got := result[0].(map[string]any)["secret"].(string)
	if got != referenceHMAC(key, secret) {
		t.Fatalf("HMAC = %s, want %s", got, referenceHMAC(key, secret))
	}
	if len(got) != sha256HexLength || strings.Contains(got, secret) {
		t.Fatalf("unexpected HMAC output length/content: %q", got)
	}
}

func TestProcessBatchRequiresKeyStoreForHMAC(t *testing.T) {
	_, err := New(nil).StartBatch(context.Background(), BatchRequest{
		Rules:  []Rule{{Path: []string{"secret"}, Action: Action{Type: ActionHMAC}}},
		Events: []Event{map[string]any{"secret": "raw"}},
	})
	if !errors.Is(err, ErrKeyStoreRequired) {
		t.Fatalf("StartBatch error = %v, want ErrKeyStoreRequired", err)
	}
}

func TestInvalidConfigIsRejectedBeforeKeyAccess(t *testing.T) {
	store := newInjectedStore([]byte("unused-key"))
	_, err := New(store).StartBatch(context.Background(), BatchRequest{
		Rules: []Rule{
			{Path: []string{"a", "*"}, Action: Action{Type: ActionDelete}},
			{Path: []string{"*", "b"}, Action: Action{Type: ActionHMAC}},
		},
		Events: []Event{map[string]any{"a": map[string]any{"b": "raw"}}},
	})
	if !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("StartBatch error = %v, want ErrInvalidConfig", err)
	}
	if currentCalls, loadCalls := store.Counts(); currentCalls != 0 || loadCalls != 0 {
		t.Fatalf("invalid config touched the keystore: current=%d load=%d", currentCalls, loadCalls)
	}
}

func TestSubmitAndProcessBatchAliases(t *testing.T) {
	request := BatchRequest{
		Rules:  []Rule{{Path: []string{"secret"}, Action: Action{Type: ActionDelete}}},
		Events: []Event{map[string]any{"secret": "raw"}},
	}
	batch, err := New(nil).Submit(context.Background(), request)
	if err != nil {
		t.Fatalf("Submit failed: %v", err)
	}
	if batch.ID == "" {
		t.Fatal("generated batch ID is empty")
	}
	result, err := batch.Process(context.Background())
	if err != nil {
		t.Fatalf("Process failed: %v", err)
	}
	if _, ok := result[0].(map[string]any)["secret"]; ok {
		t.Fatal("secret was not deleted")
	}

	result, err = New(nil).ProcessBatch(context.Background(), request)
	if err != nil {
		t.Fatalf("ProcessBatch failed: %v", err)
	}
	if !reflect.DeepEqual(result, []Event{map[string]any{}}) {
		t.Fatalf("ProcessBatch result = %#v", result)
	}
}

const sha256HexLength = 64
