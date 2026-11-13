package dataeng

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
)

// ChangeKind identifies a structured body diff event.
type ChangeKind string

const (
	EventAdd     ChangeKind = "add"
	EventDelete  ChangeKind = "delete"
	EventModify  ChangeKind = "modify"
	EventSplit   ChangeKind = "split"
	EventMerge   ChangeKind = "merge"
	EventReorder ChangeKind = "reorder"

	// Aliases intended to make switch statements read naturally.
	Add     = EventAdd
	Delete  = EventDelete
	Modify  = EventModify
	Split   = EventSplit
	Merge   = EventMerge
	Reorder = EventReorder
	// Move is an alias for Reorder. A move is an order change, not a body
	// modification.
	Move = EventReorder
)

// SourceFragment maps a target paragraph back to an interval in a source
// block. Start and End are rune offsets into SourceBlockID's Text. Document
// is the corresponding interval in the old snapshot's document coordinates
// when the source Block supplied a valid Range.
type SourceFragment struct {
	BlockID  string   `json:"block_id"`
	Start    int      `json:"start"`
	End      int      `json:"end"`
	Document TextSpan `json:"document,omitempty"`
}

// Provenance links one new block to the old block intervals from which it was
// derived. Splits produce one Provenance per new paragraph; merges produce a
// single Provenance whose Sources contains every merged paragraph.
type Provenance struct {
	BlockID string           `json:"block_id"`
	Sources []SourceFragment `json:"sources"`
}

// OrderChange describes the movement of one matched body block.
type OrderChange struct {
	BlockID  string `json:"block_id"`
	OldIndex int    `json:"old_index"`
	NewIndex int    `json:"new_index"`
}

// Event is one structured difference between two snapshots.
//
// ContentChanged and OrderChanged are deliberately independent. A block whose
// text changed and which also moved produces one modify event and one reorder
// event, never a combined event.
type Event struct {
	ID         string     `json:"id"`
	Kind       ChangeKind `json:"kind"`
	Generation string     `json:"generation,omitempty"`

	// BlockID is the stable identity of the block affected by the event.
	// OldID and NewID expose the identities on either side when they differ.
	BlockID string `json:"block_id,omitempty"`
	OldID   string `json:"old_id,omitempty"`
	NewID   string `json:"new_id,omitempty"`

	Old *Block `json:"old,omitempty"`
	New *Block `json:"new,omitempty"`

	// Sources and Targets are populated for split and merge events.
	Sources []string `json:"sources,omitempty"`
	Targets []string `json:"targets,omitempty"`

	// Mapping is the paragraph provenance for split and merge events.
	Mapping []Provenance `json:"mapping,omitempty"`

	// BeforeOrder and AfterOrder contain the matched content block IDs in
	// reading order. OrderChanges contains the subset whose position changed.
	BeforeOrder  []string      `json:"before_order,omitempty"`
	AfterOrder   []string      `json:"after_order,omitempty"`
	OrderChanges []OrderChange `json:"order_changes,omitempty"`

	ContentChanged bool `json:"content_changed"`
	OrderChanged   bool `json:"order_changed"`
}

// Result is the ordered, de-duplicated set of events for one comparison.
type Result struct {
	Generation string  `json:"generation,omitempty"`
	Events     []Event `json:"events"`
}

// ContentChanges returns every event that changes body content, including
// paragraph splits and merges. Order-only events are excluded.
func (r Result) ContentChanges() []Event {
	out := make([]Event, 0, len(r.Events))
	for _, e := range r.Events {
		if e.ContentChanged {
			out = append(out, e)
		}
	}
	return out
}

// OrderChanges returns order-only events.
func (r Result) OrderChanges() []Event {
	out := make([]Event, 0, len(r.Events))
	for _, e := range r.Events {
		if e.OrderChanged {
			out = append(out, e)
		}
	}
	return out
}

// EventsOfKind filters the result by event kind.
func (r Result) EventsOfKind(kind ChangeKind) []Event {
	out := make([]Event, 0, len(r.Events))
	for _, e := range r.Events {
		if e.Kind == kind {
			out = append(out, e)
		}
	}
	return out
}

// Event identity is deterministic for a generation and logical change. Later
// content versions of the same add/delete/modify therefore keep the same event
// ID, allowing a Ledger to emit the event only once per crawl generation.
func newEventID(generation string, kind ChangeKind, logicalKey string) string {
	sum := sha256.Sum256([]byte(generation + "\x00" + string(kind) + "\x00" + logicalKey))
	return fmt.Sprintf("%s_%s", kind, hex.EncodeToString(sum[:12]))
}

func dedupeEvents(events []Event) []Event {
	seen := make(map[string]struct{}, len(events))
	out := make([]Event, 0, len(events))
	for _, e := range events {
		if _, ok := seen[e.ID]; ok {
			continue
		}
		seen[e.ID] = struct{}{}
		out = append(out, e)
	}
	return out
}

func eventKindRank(kind ChangeKind) int {
	switch kind {
	case EventDelete:
		return 0
	case EventSplit:
		return 1
	case EventMerge:
		return 2
	case EventAdd:
		return 3
	case EventModify:
		return 4
	case EventReorder:
		return 5
	default:
		return 6
	}
}

func sortEvents(events []Event) {
	sort.SliceStable(events, func(i, j int) bool {
		ri, rj := eventKindRank(events[i].Kind), eventKindRank(events[j].Kind)
		if ri != rj {
			return ri < rj
		}
		if events[i].BlockID != events[j].BlockID {
			return events[i].BlockID < events[j].BlockID
		}
		return events[i].ID < events[j].ID
	})
}

func joinIDs(ids []string) string {
	cp := append([]string(nil), ids...)
	sort.Strings(cp)
	return strings.Join(cp, ",")
}
