package dataeng

import (
	"strings"
	"time"
)

// BlockKind classifies a block found while crawling a page. Only content
// blocks participate in body-text comparison. Advertisement, navigation and
// other page-chrome blocks may be supplied in a Snapshot, but changes to them
// never produce body diff events.
type BlockKind string

const (
	KindContent       BlockKind = "content"
	KindAdvertisement BlockKind = "advertisement"
	KindNavigation    BlockKind = "navigation"
	KindBoilerplate   BlockKind = "boilerplate"

	// Short aliases for callers that use compact constants.
	Content       = KindContent
	Advertisement = KindAdvertisement
	Navigation    = KindNavigation
	Boilerplate   = KindBoilerplate
	KindAd        = KindAdvertisement
	KindNav       = KindNavigation
	Ad            = KindAdvertisement
	Nav           = KindNavigation
)

// IsContent reports whether a block contains page body text. The zero value
// and unknown kinds are treated as content so that ordinary callers only
// have to mark the blocks they explicitly want excluded.
func (k BlockKind) IsContent() bool {
	switch strings.ToLower(strings.TrimSpace(string(k))) {
	case "ad", "ads", "advert", "advertisement", "advertising",
		"banner", "promo", "promotion", "promoted", "sponsor", "sponsored":
		return false
	case "nav", "navigation", "menu", "menubar", "breadcrumb",
		"sidebar", "footer", "header", "chrome", "boilerplate", "widget":
		return false
	default:
		return true
	}
}

// TextSpan is a half-open range of rune offsets, [Start, End). It is used
// for both document text intervals carried by a Block and for offsets into
// an individual block's Text.
type TextSpan struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

// Len returns End-Start, clamped at zero.
func (s TextSpan) Len() int {
	if s.End <= s.Start {
		return 0
	}
	return s.End - s.Start
}

// Valid reports whether the span is a non-negative, non-empty interval.
func (s TextSpan) Valid() bool {
	return s.Start >= 0 && s.End > s.Start
}

// PublishEvidence is one piece of evidence that supports a block's publication
// time. Typical sources are a meta tag, JSON-LD datePublished, or a visible
// timestamp. Evidence is carried through to add, delete and modify events so
// downstream consumers can make recency decisions.
type PublishEvidence struct {
	PublishedAt time.Time `json:"published_at"`
	Source      string    `json:"source"`
	Raw         string    `json:"raw,omitempty"`
	Confidence  float64   `json:"confidence,omitempty"`
}

// Block is one body region emitted by the crawler. Path is the DOM location
// (for example "html>body>article>div[2]>p[3]"). Text is the block's body
// text and Range is its interval in the crawled document. Range is preserved
// verbatim; the diff operates on rune offsets inside Text.
//
// ID is optional. When it is stable across snapshots it is the strongest
// identity signal. Otherwise the normalized DOM path and text are used.
type Block struct {
	ID              string            `json:"id,omitempty"`
	Kind            BlockKind         `json:"kind,omitempty"`
	Path            string            `json:"path,omitempty"`
	Text            string            `json:"text"`
	Range           TextSpan          `json:"range"`
	PublishedAt     time.Time         `json:"published_at,omitempty"`
	PublishEvidence []PublishEvidence `json:"publish_evidence,omitempty"`
}

// EffectivePublishTime returns the publication time of the highest-confidence
// evidence, falling back to Block.PublishedAt. It is a convenience for callers;
// the diff itself never drops blocks based on this value.
func (b Block) EffectivePublishTime() time.Time {
	best := b.PublishedAt
	bestConfidence := -1.0
	for _, e := range b.PublishEvidence {
		if e.PublishedAt.IsZero() {
			continue
		}
		c := e.Confidence
		if c < bestConfidence {
			continue
		}
		best = e.PublishedAt
		bestConfidence = c
	}
	return best
}

// Snapshot is one immutable crawl of a page or document. Blocks are in
// reading order. Generation identifies the crawl generation that produced the
// snapshot; a Ledger uses it to suppress duplicate events across repeated
// snapshots from that generation.
type Snapshot struct {
	ID         string    `json:"id,omitempty"`
	Generation string    `json:"generation,omitempty"`
	CapturedAt time.Time `json:"captured_at,omitempty"`
	Blocks     []Block   `json:"blocks"`
}

// ContentBlocks returns a copy of the snapshot's content blocks in reading
// order. Advertisement, navigation and boilerplate blocks are omitted.
func (s Snapshot) ContentBlocks() []Block {
	out := make([]Block, 0, len(s.Blocks))
	for _, b := range s.Blocks {
		if b.Kind.IsContent() {
			out = append(out, b)
		}
	}
	return out
}

// Diff compares this snapshot with a newer snapshot.
func (s Snapshot) Diff(newer Snapshot) Result {
	return Diff(s, newer)
}

// Compare is an alias for Snapshot.Diff.
func (s Snapshot) Compare(newer Snapshot) Result {
	return Diff(s, newer)
}
