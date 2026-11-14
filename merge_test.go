package dataeng

import (
	"testing"
	"time"
)

func rssPermalink(href string) Link {
	return Link{Href: href, Rel: "alternate"}
}

func TestSameAtomIDDifferentTitleKeepsVersionChain(t *testing.T) {
	entries := []Entry{
		{
			AtomID:    "tag:example.com,2026:post/1",
			Title:     "Old Title",
			Links:     []Link{rssPermalink("https://example.com/post/1")},
			Published: "Mon, 2 Jan 2006 15:04:05 -0700",
			Summary:   "body",
			Content:   "body",
		},
		{
			AtomID:    "tag:example.com,2026:post/1",
			Title:     "New Title",
			Links:     []Link{rssPermalink("https://example.com/post/1")},
			Published: "Tue, 3 Jan 2006 15:04:05 -0700",
			Summary:   "body",
			Content:   "body",
		},
	}

	chains := Merge(entries, nil)
	if len(chains) != 1 {
		t.Fatalf("expected 1 chain, got %d", len(chains))
	}
	chain := chains[0]
	if len(chain.Versions) != 2 {
		t.Fatalf("expected 2 versions, got %d", len(chain.Versions))
	}
	if chain.Basis.Signal != prefixAtomID {
		t.Fatalf("expected atom-id basis, got %q", chain.Basis.Signal)
	}
	found := false
	for _, kind := range chain.Versions[1].Changes {
		if kind == ChangeTitleUpdated {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected title-updated change, got %v", chain.Versions[1].Changes)
	}
	if chain.Versions[0].Entry.Title != "Old Title" || chain.Versions[1].Entry.Title != "New Title" {
		t.Fatal("original titles were not preserved")
	}
}

func TestSameGUIDDifferentBodyDoesNotOverwrite(t *testing.T) {
	entries := []Entry{
		{
			GUID:      GUID{Value: "opaque-guid-42", Kind: GUIDKindOpaque},
			Title:     "Post",
			Published: "2006-01-02T15:04:05Z",
			Summary:   "first body",
		},
		{
			GUID:      GUID{Value: "opaque-guid-42", Kind: GUIDKindOpaque},
			Title:     "Post",
			Published: "2006-01-03T15:04:05Z",
			Summary:   "second, corrected body",
		},
	}

	chains := Merge(entries, nil)
	if len(chains) != 1 {
		t.Fatalf("expected 1 chain, got %d", len(chains))
	}
	chain := chains[0]
	if len(chain.Versions) != 2 {
		t.Fatalf("both versions must be retained, got %d", len(chain.Versions))
	}
	if len(chain.ContentConflicts) < 2 {
		t.Fatalf("expected content conflict records for distinct bodies, got %d", len(chain.ContentConflicts))
	}
	if chain.Versions[0].Evidence.Summary != "first body" {
		t.Fatal("original body was overwritten")
	}
	if len(chain.DistinctDigests) != 2 {
		t.Fatalf("expected 2 distinct digests, got %v", chain.DistinctDigests)
	}
	hasContentChange := false
	for _, kind := range chain.Versions[1].Changes {
		if kind == ChangeContentUpdated {
			hasContentChange = true
		}
	}
	if !hasContentChange {
		t.Fatalf("expected content-updated change, got %v", chain.Versions[1].Changes)
	}
}

func TestPermalinkGUIDAndCanonicalLinkMerge(t *testing.T) {
	entries := []Entry{
		{
			GUID:  GUID{Value: "https://example.com/a?utm_source=newsletter", Kind: GUIDKindPermalink},
			Title: "A",
		},
		{
			Title: "A",
			Links: []Link{{Href: "https://example.com/a", Rel: "canonical", Canonical: true}},
		},
	}

	chains := Merge(entries, nil)
	if len(chains) != 1 {
		t.Fatalf("tracking params and canonical link should resolve to one chain, got %d", len(chains))
	}
	chain := chains[0]
	if chain.Basis.Kind != sigURL {
		t.Fatalf("expected permalink-url basis, got %q", chain.Basis.Kind)
	}
}

func TestOpaqueGUIDIsNeverTreatedAsURL(t *testing.T) {
	entries := []Entry{
		{GUID: GUID{Value: "https://example.com/looks-like-url", Kind: GUIDKindOpaque}, Title: "A"},
		{Links: []Link{rssPermalink("https://example.com/looks-like-url")}, Title: "B"},
	}

	chains := Merge(entries, nil)
	if len(chains) != 2 {
		t.Fatalf("opaque guid must not match by URL, got %d chains", len(chains))
	}
}

func TestDomainMigrationPreservesChain(t *testing.T) {
	entries := []Entry{
		{
			Title:   "Post",
			Links:   []Link{rssPermalink("https://old.example.com/articles/123")},
			Summary: "same body",
			Content: "same body",
		},
		{
			Title:   "Post",
			Links:   []Link{rssPermalink("https://new.example.org/articles/123")},
			Summary: "same body",
			Content: "same body",
		},
	}

	chains := Merge(entries, nil)
	if len(chains) != 1 {
		t.Fatalf("domain migration with identical body must keep one chain, got %d", len(chains))
	}
	chain := chains[0]
	hasBridge := false
	for _, decision := range chain.Matches {
		if decision.Signal == prefixBridge {
			hasBridge = true
		}
	}
	if !hasBridge {
		t.Fatal("expected host-agnostic bridge evidence")
	}
}

func TestDomainMigrationDifferentBodyStaysSeparate(t *testing.T) {
	entries := []Entry{
		{
			Title:   "Post",
			Links:   []Link{rssPermalink("https://old.example.com/articles/123")},
			Summary: "body one",
		},
		{
			Title:   "Post",
			Links:   []Link{rssPermalink("https://new.example.org/articles/123")},
			Summary: "body two",
		},
	}

	chains := Merge(entries, nil)
	if len(chains) != 2 {
		t.Fatalf("bridge requires identical body, got %d chains", len(chains))
	}
}

func TestDigestFallbackForGUIDlessItems(t *testing.T) {
	entries := []Entry{
		{Title: "No ID", Links: []Link{{Href: "", Rel: "self"}}, Summary: "shared body"},
		{Title: "No ID", Summary: "shared body"},
	}

	chains := Merge(entries, nil)
	if len(chains) != 1 {
		t.Fatalf("guid-less duplicates should merge on digest, got %d", len(chains))
	}
	if chains[0].Basis.Kind != sigDigest {
		t.Fatalf("expected digest basis, got %q", chains[0].Basis.Kind)
	}
}

func TestUnchangedRedeliveryMarkedDuplicate(t *testing.T) {
	entries := []Entry{
		{GUID: GUID{Value: "g1", Kind: GUIDKindUnknown}, Title: "T", Summary: "same"},
		{GUID: GUID{Value: "g1", Kind: GUIDKindUnknown}, Title: "T", Summary: "same"},
	}

	chains := Merge(entries, nil)
	chain := chains[0]
	if !chain.Versions[1].Duplicate {
		t.Fatal("identical re-delivery should be marked duplicate")
	}
	if len(chain.ContentConflicts) != 0 {
		t.Fatal("identical bodies must not raise content conflicts")
	}
}

func TestUnparseableDatesExcludedFromAdjudication(t *testing.T) {
	entries := []Entry{
		{GUID: GUID{Value: "g1", Kind: GUIDKindOpaque}, Title: "T", Published: "not-a-date", Summary: "a"},
		{GUID: GUID{Value: "g1", Kind: GUIDKindOpaque}, Title: "T", Published: "also-broken", Summary: "b"},
	}

	chains := Merge(entries, nil)
	chain := chains[0]
	if chain.Latest != nil {
		t.Fatal("chain without parseable dates must not elect a latest version")
	}
	if len(chain.RankedVersions) != 0 {
		t.Fatal("undated versions must not appear in ranking")
	}
	for _, version := range chain.Versions {
		if len(version.DateIssues) == 0 {
			t.Fatalf("seq %d expected date issues with raw evidence", version.Sequence)
		}
		for _, issue := range version.DateIssues {
			if issue.RawValue == "" || issue.Err == "" {
				t.Fatal("date issue must retain the raw value and an error explanation")
			}
		}
		if version.AdjudicatedTime != nil {
			t.Fatal("failed parse must never produce an adjudication time")
		}
	}
}

func TestLatestUsesUpdatedThenPublished(t *testing.T) {
	older := time.Date(2006, 1, 2, 0, 0, 0, 0, time.UTC)
	entries := []Entry{
		{
			GUID:      GUID{Value: "g1", Kind: GUIDKindOpaque},
			Title:     "newer first in feed",
			Published: "2006-01-05T00:00:00Z",
			Updated:   "2006-01-06T00:00:00Z",
			Summary:   "x",
		},
		{
			GUID:      GUID{Value: "g1", Kind: GUIDKindOpaque},
			Title:     "older",
			Published: "2006-01-03T00:00:00Z",
			Summary:   "y",
		},
	}

	chains := Merge(entries, nil)
	chain := chains[0]
	if chain.Latest == nil || chain.Latest.Sequence != 1 {
		t.Fatalf("expected seq 1 as latest, got %v", chain.Latest)
	}
	if !chain.Latest.AdjudicatedTime.Equal(older.AddDate(0, 0, 4)) {
		t.Fatalf("expected updated timestamp to win, got %v", chain.Latest.AdjudicatedTime)
	}
}
