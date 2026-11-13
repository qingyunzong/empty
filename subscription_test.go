package dataeng

import (
	"errors"
	"reflect"
	"testing"
)

func notification(n byte) []NotificationData {
	return []NotificationData{{Payload: []byte{n}}}
}

func publish(seq uint32, available ...uint32) PublishResponse {
	return PublishResponse{
		SequenceNumber:           seq,
		AvailableSequenceNumbers: available,
		NotificationData:         notification(byte(seq)),
	}
}

func TestSequenceGapIsRepublishedBeforeItIsMarkedMissing(t *testing.T) {
	s := NewSubscription()

	res := s.HandlePublish(publish(1, 1))
	if !res.Accepted || res.Duplicate || res.Stale {
		t.Fatalf("sequence 1 result = %+v", res)
	}
	if got := s.PendingRepublish(); len(got) != 0 {
		t.Fatalf("unexpected pending gaps: %v", got)
	}

	res = s.HandlePublish(publish(3, 1, 2, 3))
	if !res.Accepted {
		t.Fatalf("sequence 3 rejected: %+v", res)
	}
	if got, want := s.PendingRepublish(), []uint32{2}; !reflect.DeepEqual(got, want) {
		t.Fatalf("pending = %v, want %v", got, want)
	}
	if got := s.PermanentlyMissing(); len(got) != 0 {
		t.Fatalf("gap was marked missing before republish: %v", got)
	}

	republished := s.HandleRepublish(RepublishResponse{
		SequenceNumber:           2,
		Status:                   BadMessageNotAvailable,
		AvailableSequenceNumbers: []uint32{1, 3},
	})
	if !republished.Permanent {
		t.Fatalf("unavailable republish result = %+v", republished)
	}
	if got, want := s.PermanentlyMissing(), []uint32{2}; !reflect.DeepEqual(got, want) {
		t.Fatalf("missing = %v, want %v", got, want)
	}
	if got := s.PendingRepublish(); len(got) != 0 {
		t.Fatalf("gap still pending after confirmation: %v", got)
	}
}

func TestAbsenceFromAvailableListDoesNotProveLoss(t *testing.T) {
	s := NewSubscription()
	s.HandlePublish(publish(1, 1))
	s.HandlePublish(publish(3, 1, 3)) // 2 is not advertised as available

	if got, want := s.PendingRepublish(), []uint32{2}; !reflect.DeepEqual(got, want) {
		t.Fatalf("pending = %v, want %v", got, want)
	}
	if got := s.PermanentlyMissing(); len(got) != 0 {
		t.Fatalf("absence from available list was treated as proof of loss: %v", got)
	}
}

func TestTransientRepublishFailureKeepsGapPending(t *testing.T) {
	s := NewSubscription()
	s.HandlePublish(publish(1))
	s.HandlePublish(publish(3))

	res := s.HandleRepublish(RepublishResponse{
		SequenceNumber: 2,
		Status:         BadTimeout,
	})
	if res.Permanent {
		t.Fatalf("timeout marked gap permanently missing: %+v", res)
	}
	if res.Err == nil {
		t.Fatalf("transient failure did not report an error: %+v", res)
	}
	if got, want := s.PendingRepublish(), []uint32{2}; !reflect.DeepEqual(got, want) {
		t.Fatalf("pending = %v, want %v", got, want)
	}
}

func TestSuccessfulRepublishFillsGap(t *testing.T) {
	s := NewSubscription()
	s.HandlePublish(publish(1))
	s.HandlePublish(publish(3))

	res := s.HandleRepublish(RepublishResponse{
		SequenceNumber:   2,
		Status:           Good,
		NotificationData: notification(2),
		Persisted:        true,
	})
	if !res.Accepted {
		t.Fatalf("republished sequence rejected: %+v", res)
	}
	if got := s.PendingRepublish(); len(got) != 0 {
		t.Fatalf("pending after republish = %v", got)
	}
	if got := s.PermanentlyMissing(); len(got) != 0 {
		t.Fatalf("unexpected missing: %v", got)
	}
}

func TestKeepAliveDoesNotAdvanceNotificationSequence(t *testing.T) {
	s := NewSubscription()
	s.HandlePublish(publish(1))

	res := s.KeepAlive(2)
	if !res.KeepAlive || res.Accepted || res.Stale {
		t.Fatalf("keep-alive result = %+v", res)
	}
	if got := s.PendingRepublish(); len(got) != 0 {
		t.Fatalf("keep-alive created a gap: %v", got)
	}

	res = s.HandlePublish(publish(2))
	if !res.Accepted {
		t.Fatalf("notification after keep-alive rejected: %+v", res)
	}
	if got, want := s.PendingRepublish(), []uint32(nil); !reflect.DeepEqual(got, want) {
		t.Fatalf("pending = %v", got)
	}
}

func TestKeepAliveSequenceCanRevealGap(t *testing.T) {
	s := NewSubscription()
	s.HandlePublish(publish(1))
	s.KeepAlive(3) // next notification is 3, so 2 was sent and was missed

	if got, want := s.PendingRepublish(), []uint32{2}; !reflect.DeepEqual(got, want) {
		t.Fatalf("pending = %v, want %v", got, want)
	}
}

func TestTransferInvalidatesOldSessionResponses(t *testing.T) {
	s := NewSubscription("old")
	s.HandlePublish(PublishResponse{
		SessionID:        "old",
		SubscriptionID:   7,
		SequenceNumber:   1,
		NotificationData: notification(1),
	})
	s.HandlePublish(PublishResponse{
		SessionID:        "old",
		SubscriptionID:   7,
		SequenceNumber:   3,
		NotificationData: notification(3),
	})

	if err := s.Transfer("new"); err != nil {
		t.Fatal(err)
	}
	if got := s.Generation(); got != 1 {
		t.Fatalf("generation = %d, want 1", got)
	}

	oldPublish := s.HandlePublish(PublishResponse{
		SessionID:        "old",
		SubscriptionID:   7,
		SequenceNumber:   4,
		NotificationData: notification(4),
	})
	if !oldPublish.Stale || !errors.Is(oldPublish.Err, ErrStaleSession) {
		t.Fatalf("old publish response was not stale: %+v", oldPublish)
	}
	oldRepublish := s.HandleRepublish(RepublishResponse{
		SessionID:      "old",
		SubscriptionID: 7,
		SequenceNumber: 2,
		Status:         BadMessageNotAvailable,
	})
	if !oldRepublish.Stale {
		t.Fatalf("old republish response was not stale: %+v", oldRepublish)
	}
	if got, want := s.PendingRepublish(), []uint32{2}; !reflect.DeepEqual(got, want) {
		t.Fatalf("old republish changed state: %v, want %v", got, want)
	}

	newPublish := s.HandlePublish(PublishResponse{
		SessionID:        "new",
		SubscriptionID:   7,
		SequenceNumber:   4,
		NotificationData: notification(4),
	})
	if !newPublish.Accepted {
		t.Fatalf("new session publish rejected: %+v", newPublish)
	}
}

func TestTransferRejectsWrongOldSession(t *testing.T) {
	s := NewSubscription("current")
	if err := s.Transfer("wrong", "next"); !errors.Is(err, ErrStaleSession) {
		t.Fatalf("Transfer error = %v, want ErrStaleSession", err)
	}
	if got := s.SessionID(); got != "current" {
		t.Fatalf("session changed on rejected transfer: %q", got)
	}
}

func TestAcknowledgeOnlyCrossesPersistedOrPermanent(t *testing.T) {
	s := NewSubscription()
	s.HandlePublish(publish(1))
	s.HandlePublish(publish(3))

	if got := s.Ack(); got != 0 {
		t.Fatalf("ack before persistence = %d, want 0", got)
	}
	if err := s.AcknowledgeThrough(3); !errors.Is(err, ErrNotPersisted) {
		t.Fatalf("AcknowledgeThrough error = %v, want ErrNotPersisted", err)
	}
	if got := s.AckSequence(); got != 0 {
		t.Fatalf("ack moved before persistence: %d", got)
	}

	if err := s.Persist(1); err != nil {
		t.Fatal(err)
	}
	if got := s.Ack(); got != 1 {
		t.Fatalf("ack after sequence 1 persistence = %d, want 1", got)
	}

	s.MarkUnavailable(2)
	if got := s.Ack(); got != 2 {
		t.Fatalf("ack should reach permanent gap 2 but not unpersisted sequence 3: %d", got)
	}
	if err := s.Persist(3); err != nil {
		t.Fatal(err)
	}
	if got := s.Ack(); got != 3 {
		t.Fatalf("ack after persistence + permanent gap = %d, want 3", got)
	}
	if got := s.Ack(); got != 3 {
		t.Fatalf("repeated ack = %d, want 3", got)
	}
}

func TestAutoPersistedNotificationCanBeAcknowledgedImmediately(t *testing.T) {
	s := NewSubscription()
	res := s.HandlePublish(PublishResponse{
		SequenceNumber:   1,
		NotificationData: notification(1),
		Persisted:        true,
	})
	if got, want := res.AckSequence, uint32(1); got != want {
		t.Fatalf("safe ack = %d, want %d", got, want)
	}
	if got := s.Ack(); got != 1 {
		t.Fatalf("ack = %d, want 1", got)
	}
}

func TestDuplicatePublishDoesNotDuplicateNotification(t *testing.T) {
	s := NewSubscription()
	s.HandlePublish(publish(1))
	res := s.HandlePublish(publish(1))
	if !res.Duplicate || res.Accepted {
		t.Fatalf("duplicate result = %+v", res)
	}
	if got := s.AckSequence(); got != 0 {
		t.Fatalf("duplicate moved ack: %d", got)
	}
}

func TestPersistRejectsPendingAndMissing(t *testing.T) {
	s := NewSubscription()
	s.HandlePublish(publish(1))
	s.HandlePublish(publish(3))
	if err := s.Persist(2); !errors.Is(err, ErrNotReceived) {
		t.Fatalf("Persist pending error = %v", err)
	}
	s.MarkUnavailable(2)
	if err := s.Persist(2); !errors.Is(err, ErrPermanentMissing) {
		t.Fatalf("Persist missing error = %v", err)
	}
}

func TestPersistThroughLeavesGapsBlockingAck(t *testing.T) {
	s := NewSubscription()
	s.HandlePublish(publish(1))
	s.HandlePublish(publish(3))
	if err := s.PersistThrough(3); err != nil {
		t.Fatal(err)
	}
	if got := s.Ack(); got != 1 {
		t.Fatalf("ack = %d, want 1 because sequence 2 is pending", got)
	}
	s.MarkUnavailable(2)
	if got := s.Ack(); got != 3 {
		t.Fatalf("ack = %d, want 3", got)
	}
}

func TestConstructorForms(t *testing.T) {
	tests := []struct {
		name    string
		s       *Subscription
		session string
		sub     uint32
	}{
		{"empty", NewSubscription(), "", 0},
		{"config", NewSubscription(Config{SessionID: "s", SubscriptionID: 4}), "s", 4},
		{"options", NewSubscription(WithSessionID("s"), WithSubscriptionID(4)), "s", 4},
		{"args", NewSubscription("s", 4), "s", 4},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.s.SessionID() != tt.session || tt.s.SubscriptionID() != tt.sub {
				t.Fatalf("session/sub = %q/%d", tt.s.SessionID(), tt.s.SubscriptionID())
			}
		})
	}
}

func TestSequenceWrap(t *testing.T) {
	s := NewSubscription()
	s.HandlePublish(publish(0xFFFFFFFE))
	res := s.HandlePublish(publish(1))
	if !res.Accepted {
		t.Fatalf("wrapped sequence rejected: %+v", res)
	}
	if got, want := s.PendingRepublish(), []uint32{0xFFFFFFFF}; !reflect.DeepEqual(got, want) {
		t.Fatalf("pending = %v, want %v", got, want)
	}
}

func TestCompactArgumentForms(t *testing.T) {
	s := NewSubscription("session")
	if res := s.HandlePublish("session", uint32(1), notification(1)); !res.Accepted {
		t.Fatalf("compact publish rejected: %+v", res)
	}
	if res := s.HandlePublish("session", uint32(3), notification(3)); !res.Accepted {
		t.Fatalf("compact publish rejected: %+v", res)
	}
	if res := s.HandleRepublish(uint32(2), BadMessageNotAvailable); !res.Permanent {
		t.Fatalf("compact republish did not mark permanent: %+v", res)
	}
}

func TestBareSequenceNumberIsATrackedNotification(t *testing.T) {
	s := NewSubscription()
	if res := s.HandlePublish(PublishResponse{SequenceNumber: 1}); !res.Accepted {
		t.Fatalf("bare sequence 1 was not accepted: %+v", res)
	}
	res := s.HandlePublish(PublishResponse{SequenceNumber: 3})
	if !res.Accepted {
		t.Fatalf("bare sequence 3 was not accepted: %+v", res)
	}
	if got, want := s.PendingRepublish(), []uint32{2}; !reflect.DeepEqual(got, want) {
		t.Fatalf("pending = %v, want %v", got, want)
	}
}
