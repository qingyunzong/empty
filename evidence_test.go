package dataeng

import (
	"strings"
	"testing"
)

func TestEvidencePreservesRawFields(t *testing.T) {
	entry := Entry{
		FeedURL:   "https://example.com/feed.xml",
		AtomID:    "tag:example.com,2026:42",
		GUID:      GUID{Value: "guid-raw", Kind: GUIDKindOpaque},
		Links:     []Link{{Href: "/posts/42?utm_source=x", Rel: "alternate"}},
		Link:      "https://example.com/legacy/42",
		Title:     "  Spaced   Title  ",
		Published: "Mon, 02 Jan 2006 15:04:05 -0700",
		Updated:   "2006-01-03T15:04:05Z",
		Summary:   "sum",
		Content:   "body",
	}

	chains := Merge([]Entry{entry}, nil)
	chain := chains[0]
	version := chain.Versions[0]
	evidence := version.Evidence

	if evidence.AtomID != entry.AtomID || evidence.GUIDValue != "guid-raw" {
		t.Fatal("raw atom id / guid not preserved")
	}
	if evidence.GUIDKind != GUIDKindOpaque {
		t.Fatal("guid permalink flag not preserved")
	}
	if evidence.Title != entry.Title || evidence.Published != entry.Published ||
		evidence.Updated != entry.Updated || evidence.Summary != "sum" || evidence.Content != "body" {
		t.Fatal("verbatim fields must be retained as evidence")
	}
	if evidence.PermalinkRawHref != "/posts/42?utm_source=x" {
		t.Fatalf("raw href before normalization must be kept, got %q", evidence.PermalinkRawHref)
	}
	if evidence.CanonicalHref != "https://example.com/posts/42" {
		t.Fatalf("expected resolved, tracking-stripped URL, got %q", evidence.CanonicalHref)
	}
	if len(evidence.AllLinks) != 1 || evidence.AllLinks[0].Href != "/posts/42?utm_source=x" {
		t.Fatal("original link list must be preserved")
	}
	if evidence.LegacyLink != entry.Link {
		t.Fatal("legacy RSS link must be preserved")
	}
	if evidence.ContentDigest == "" || len(evidence.ContentDigest) != 64 {
		t.Fatal("expected sha256 hex digest in evidence")
	}
	if len(version.Matches) == 0 {
		t.Fatal("founding version must carry identity evidence")
	}
}

func TestRelativeLinksResolveAgainstFeedURL(t *testing.T) {
	entries := []Entry{
		{FeedURL: "https://example.com/feed/atom.xml", Links: []Link{rssPermalink("../post/9")}, Title: "A", Summary: "s"},
		{FeedURL: "https://example.com/feed/atom.xml", Links: []Link{rssPermalink("https://example.com/post/9")}, Title: "A", Summary: "s"},
	}

	chains := Merge(entries, nil)
	if len(chains) != 1 {
		t.Fatalf("relative link should resolve and merge, got %d chains", len(chains))
	}
}

func TestThreeWayUnionAcrossSignals(t *testing.T) {
	entries := []Entry{
		{AtomID: "atom-1", GUID: GUID{Value: "g1", Kind: GUIDKindOpaque}, Title: "A", Summary: "s"},
		{GUID: GUID{Value: "g1", Kind: GUIDKindOpaque}, Links: []Link{rssPermalink("https://example.com/p/1")}, Title: "A", Summary: "s"},
		{Links: []Link{rssPermalink("https://example.com/p/1?utm_campaign=email")}, Title: "A", Summary: "s"},
	}

	chains := Merge(entries, nil)
	if len(chains) != 1 {
		t.Fatalf("transitive identity signals must join all three, got %d", len(chains))
	}
	if len(chains[0].Versions) != 3 {
		t.Fatalf("expected 3 versions, got %d", len(chains[0].Versions))
	}
}

func TestDistinctEntriesStaySeparate(t *testing.T) {
	entries := []Entry{
		{GUID: GUID{Value: "g1", Kind: GUIDKindOpaque}, Title: "A", Summary: "x"},
		{GUID: GUID{Value: "g2", Kind: GUIDKindOpaque}, Title: "B", Summary: "y"},
	}

	chains := Merge(entries, nil)
	if len(chains) != 2 {
		t.Fatalf("expected 2 chains, got %d", len(chains))
	}
	if chains[0].Versions[0].Sequence != 1 || chains[1].Versions[0].Sequence != 2 {
		t.Fatal("chains should be ordered by first-seen sequence")
	}
}

func TestRFC822DatesRankNewest(t *testing.T) {
	entries := []Entry{
		{GUID: GUID{Value: "g1", Kind: GUIDKindOpaque}, Title: "old", Published: "Mon, 2 Jan 2006 10:00:00 MST", Summary: "a"},
		{GUID: GUID{Value: "g1", Kind: GUIDKindOpaque}, Title: "new", Published: "Wed, 4 Jan 2006 10:00:00 MST", Summary: "b"},
	}

	chains := Merge(entries, nil)
	chain := chains[0]
	if chain.Latest == nil || chain.Latest.Entry.Title != "new" {
		t.Fatalf("RFC822 dates must determine latest, got %v", chain.Latest)
	}
	if len(chain.RankedVersions) != 2 {
		t.Fatal("both dated versions should be ranked")
	}
}

func TestSingleBadDateStillAdjudicatesFromGoodDate(t *testing.T) {
	entries := []Entry{
		{GUID: GUID{Value: "g1", Kind: GUIDKindOpaque}, Title: "a", Published: "2006-01-02T10:00:00Z", Updated: "garbage", Summary: "a"},
		{GUID: GUID{Value: "g1", Kind: GUIDKindOpaque}, Title: "b", Published: "2006-01-05T10:00:00Z", Summary: "b"},
	}

	chains := Merge(entries, nil)
	chain := chains[0]
	if chain.Latest == nil || chain.Latest.Sequence != 2 {
		t.Fatalf("good published date should still adjudicate, got %v", chain.Latest)
	}
	hasIssue := false
	for _, issue := range chain.Versions[0].DateIssues {
		if issue.Field == "updated" && strings.Contains(issue.RawValue, "garbage") {
			hasIssue = true
		}
	}
	if !hasIssue {
		t.Fatal("unparseable updated field must remain visible as evidence")
	}
}

func TestEmptyMergeReturnsEmpty(t *testing.T) {
	if got := Merge(nil, nil); len(got) != 0 {
		t.Fatalf("expected no chains, got %d", len(got))
	}
}

func TestChangeHistoryRecordsDomainMigration(t *testing.T) {
	entries := []Entry{
		{GUID: GUID{Value: "stable-guid", Kind: GUIDKindOpaque}, Links: []Link{rssPermalink("https://old.example.com/a")}, Title: "T", Summary: "s"},
		{GUID: GUID{Value: "stable-guid", Kind: GUIDKindOpaque}, Links: []Link{rssPermalink("https://new.example.com/a")}, Title: "T", Summary: "s"},
	}

	chains := Merge(entries, nil)
	chain := chains[0]
	if len(chain.ChangeHistory) != 1 {
		t.Fatalf("expected one change record, got %d", len(chain.ChangeHistory))
	}
	found := false
	for _, kind := range chain.ChangeHistory[0].Kinds {
		if kind == ChangeDomainMigrated {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected domain-migrated change, got %v", chain.ChangeHistory[0].Kinds)
	}
}

func TestIDStableAcrossIngestion(t *testing.T) {
	entries := []Entry{{GUID: GUID{Value: "g1", Kind: GUIDKindOpaque}, Title: "T", Summary: "s"}}
	first := Merge(entries, nil)[0]
	second := Merge(entries, nil)[0]
	if first.ID != second.ID || first.ID == "" {
		t.Fatal("chain ID must be deterministic")
	}
}
