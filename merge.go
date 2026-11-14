// Package dataeng merges syndication feed entries (Atom/RSS) into stable
// identity chains.
//
// Entry identity is established jointly from the Atom id, the RSS guid and
// its isPermalink flag, the canonical/permalink link and a digest of the
// body. Re-encounters of the same entry become versions of one chain, so a
// source site changing a title or migrating to a new domain does not create
// a spurious new entry. Two entries that share a guid/link/atom-id but carry
// different bodies are never silently overwritten: they are kept as separate
// versions and the chain records an explicit content conflict.
//
// Dates that fail to parse never participate in the newer/older decision;
// such versions are flagged with the raw timestamp preserved as evidence.
package dataeng

import (
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
)

// GUIDKind classifies how an RSS guid (or an Atom id) should be interpreted.
type GUIDKind string

const (
	// GUIDKindUnknown means no explicit isPermalink attribute was present;
	// the value is treated as an opaque identifier, the safe RSS default.
	GUIDKindUnknown GUIDKind = "opaque"
	// GUIDKindPermalink means the guid value is a permanent URL (RSS
	// isPermalink="true").
	GUIDKindPermalink GUIDKind = "permalink"
	// GUIDKindOpaque means the element is explicitly not a URL
	// (RSS isPermalink="false").
	GUIDKindOpaque GUIDKind = "opaque-non-permalink"
	// GUIDKindAtomID marks an Atom <id> element.
	GUIDKindAtomID GUIDKind = "atom-id"
)

// GUID is the raw entry identifier.
type GUID struct {
	// Value is the verbatim guid/id text from the feed.
	Value string
	// Kind records whether the value is a permalink, an opaque token or an
	// Atom id.
	Kind GUIDKind
}

// Link is a single entry link as it appeared in the source feed.
type Link struct {
	// Href is the verbatim href (it may be relative to the feed URL).
	Href string
	// Rel is the Atom relation, e.g. "alternate" or "self".
	Rel string
	// Canonical marks links explicitly declared canonical (Atom
	// rel="canonical" or an HTML canonical link surfaced by the parser).
	Canonical bool
}

// Entry is a single feed item in a feed-agnostic shape. Parsers for Atom and
// RSS populate the same structure; every field is preserved verbatim so that
// merge decisions can be explained with the original evidence.
type Entry struct {
	// FeedURL is the URL of the feed the item came from. It is used to
	// resolve relative links and is retained in the evidence.
	FeedURL string
	// AtomID is the Atom <id> value, empty for RSS items without one.
	AtomID string
	// GUID is the RSS <guid>, including its permalink interpretation.
	GUID GUID
	// Links holds every entry link in source order.
	Links []Link
	// Title is the verbatim entry title.
	Title string
	// Link is the legacy RSS <link> element (often empty when Links is used).
	Link string
	// Published and Updated are raw date strings exactly as serialized.
	Published string
	Updated   string
	// Summary and Content are the verbatim summary/description and body.
	Summary string
	Content string
}

// DateIssue describes a raw date field that could not be parsed.
type DateIssue struct {
	// Field is "published" or "updated".
	Field string
	// RawValue is the unparsed original string.
	RawValue string
	// Err is the parse failure message.
	Err string
}

// FieldEvidence is the raw and derived evidence attached to one version.
type FieldEvidence struct {
	// AtomID is the verbatim Atom id.
	AtomID string
	// GUIDValue and GUIDKind are the verbatim RSS guid and its permalink flag.
	GUIDValue string
	GUIDKind  GUIDKind
	// CanonicalHref is the link selected as the canonical/permalink URL,
	// empty when the entry has no usable absolute URL.
	CanonicalHref string
	// PermalinkRawHref is the link as written before resolution/normalization.
	PermalinkRawHref string
	// AllLinks are the verbatim entry links.
	AllLinks []Link
	// LegacyLink is the verbatim RSS <link> element.
	LegacyLink string
	// Title, Published, Updated, Summary and Content are the verbatim fields.
	Title     string
	Published string
	Updated   string
	Summary   string
	Content   string
	// ContentDigest is the fingerprint computed over Summary and Content.
	ContentDigest string
}

// ChangeKind enumerates how a version differs from the previous version in
// its chain.
type ChangeKind string

const (
	ChangeFirstSeen      ChangeKind = "first-seen"
	ChangeUnchanged      ChangeKind = "unchanged"
	ChangeTitleUpdated   ChangeKind = "title-updated"
	ChangeContentUpdated ChangeKind = "content-updated"
	ChangeDomainMigrated ChangeKind = "domain-migrated"
)

// ChangeRecord captures the difference between consecutive chain versions.
type ChangeRecord struct {
	FromVersion int
	ToVersion   int
	Kinds       []ChangeKind
}

// Version is one observation of an entry inside a chain.
type Version struct {
	// Sequence is the global ingestion order, starting at one.
	Sequence int
	// Entry is the complete verbatim entry supplied by the caller.
	Entry Entry
	// Evidence exposes the raw fields and computed digest used for decisions.
	Evidence FieldEvidence
	// AdjudicatedTime is the time used for newer/older ordering. It is nil
	// when every raw date failed to parse, in which case DateIssues explains
	// why the version takes no part in date-based adjudication.
	AdjudicatedTime *time.Time
	// DateIssues holds one element per raw date field that failed to parse.
	DateIssues []DateIssue
	// Matches are the identity signals that attached this version to the
	// chain, including the first version's own founding signals.
	Matches []MatchDecision
	// Duplicate is true when an identical entry (same digest) had already
	// been observed under the same identity.
	Duplicate bool
	// Changes describe the difference from the immediately preceding version.
	Changes []ChangeKind
}

// ContentConflict records versions sharing a strong identity whose bodies
// differ, so the difference is never lost through a silent overwrite.
type ContentConflict struct {
	Versions []int
	Digests  []string
	Reason   string
}

// MatchDecision is one piece of evidence explaining why two versions belong
// to the same chain.
type MatchDecision struct {
	// Signal is the identity key prefix: sigAtomID, sigOpaqueGUID, sigURL,
	// sigBridge or sigDigest.
	Signal string
	// Kind is the human-readable signal classification.
	Kind string
	// Raw is the original field value backing the signal.
	Raw string
	// Normalized is the canonical key used for comparison.
	Normalized string
	// Versions are the ingestion sequences joined by this signal; for a
	// founding signal both values are the same sequence.
	Versions [2]int
}

// IdentityBasis records the strongest identity signal that defines a chain.
type IdentityBasis struct {
	// Signal is the identity key prefix of the strongest signal.
	Signal string
	// Kind is the human-readable signal classification.
	Kind string
	// Raw is the original field value of the founding version.
	Raw string
	// Normalized is the canonical key.
	Normalized string
}

// Chain is the merged identity of one logical entry across all its versions.
type Chain struct {
	// ID is a stable opaque identifier derived from the strongest signal.
	ID string
	// Basis is the strongest identity signal that founded the chain.
	Basis IdentityBasis
	// Versions are every observation in ingestion order, including
	// duplicates and content conflicts; nothing is silently dropped.
	Versions []*Version
	// RankedVersions are versions with parseable dates, newest first.
	RankedVersions []*Version
	// Latest is the newest version according to parsed dates. It is nil when
	// no version has a parseable date, because unparseable dates cannot take
	// part in the newer/older decision.
	Latest *Version
	// Matches are the union of identity evidence across the whole chain.
	Matches []MatchDecision
	// ContentConflicts lists the distinct bodies seen under one identity.
	ContentConflicts []ContentConflict
	// ChangeHistory walks the differences between consecutive versions.
	ChangeHistory []ChangeRecord
	// DistinctDigests are the body fingerprints observed in the chain.
	DistinctDigests []string
}

// Signal kind labels used in evidence.
const (
	sigAtomID = "atom-id"
	sigOpaque = "opaque-guid"
	sigURL    = "permalink-url"
	sigBridge = "host-agnostic-url"
	sigDigest = "content-digest"
)

// Signal key prefixes used internally and surfaced verbatim in evidence.
const (
	prefixAtomID = "atom-id:"
	prefixOpaque = "opaque-guid:"
	prefixURL    = "url:"
	prefixBridge = "bridge:"
	prefixDigest = "digest:"
)

var whitespaceRun = regexp.MustCompile(`\s+`)

// DefaultDateFormats covers RFC822/RSS, RFC3339/Atom and the common legacy
// syndication layouts. MergerOptions.DateFormats can replace the list.
var DefaultDateFormats = []string{
	time.RFC1123Z,
	time.RFC1123,
	time.RFC822Z,
	time.RFC822,
	time.RFC3339Nano,
	time.RFC3339,
	"2006-01-02T15:04:05",
	"2006-01-02 15:04:05",
	"2006-01-02",
	"Mon, 2 Jan 2006 15:04:05 MST",
	"Mon, 2 Jan 2006 15:04:05 -0700",
	"Mon Jan 2 15:04:05 MST 2006",
	"January 2, 2006",
	"Jan 2, 2006",
}

// MergerOptions customizes a Merger.
type MergerOptions struct {
	// DateFormats overrides the layouts tried when parsing raw date strings.
	DateFormats []string
	// StripQueryParams lists query parameters removed before URL comparison;
	// the default removes common tracking parameters.
	StripQueryParams []string
}

type versionState struct {
	version   *Version
	strong    []string
	bridges   []bridgeSignal
	digestKey string
}

type bridgeSignal struct {
	key string
	raw string
}

// Merger accumulates entries and groups them into identity chains.
type Merger struct {
	formats   []string
	strip     map[string]struct{}
	parents   []int
	ranks     []int
	states    []*versionState
	decisions []MatchDecision

	strongOwn map[string]int
	bridgeOwn map[string]int
	digestOwn map[string]int
}

// NewMerger builds a Merger with the given options; nil applies defaults.
func NewMerger(opts *MergerOptions) *Merger {
	formats := DefaultDateFormats
	stripList := []string{"utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "mc_cid", "mc_eid"}
	if opts != nil {
		if len(opts.DateFormats) > 0 {
			formats = opts.DateFormats
		}
		if len(opts.StripQueryParams) > 0 {
			stripList = opts.StripQueryParams
		}
	}
	strip := make(map[string]struct{}, len(stripList))
	for _, param := range stripList {
		strip[param] = struct{}{}
	}
	return &Merger{
		formats:   formats,
		strip:     strip,
		strongOwn: make(map[string]int),
		bridgeOwn: make(map[string]int),
		digestOwn: make(map[string]int),
	}
}

func (m *Merger) find(index int) int {
	root := index
	for m.parents[root] != root {
		root = m.parents[root]
	}
	for m.parents[index] != index {
		parent := m.parents[index]
		m.parents[index] = root
		index = parent
	}
	return root
}

func (m *Merger) union(a, b int) int {
	ra := m.find(a)
	rb := m.find(b)
	if ra == rb {
		return ra
	}
	if m.ranks[ra] < m.ranks[rb] {
		ra, rb = rb, ra
	}
	m.parents[rb] = ra
	if m.ranks[ra] == m.ranks[rb] {
		m.ranks[ra]++
	}
	return ra
}

// recordDecision stores a match, de-duplicating identical evidence tuples.
func (m *Merger) recordDecision(seqA, seqB int, prefix, kind, raw, normalized string) {
	pair := [2]int{seqA, seqB}
	for i := range m.decisions {
		d := &m.decisions[i]
		if d.Signal == prefix && d.Normalized == normalized && d.Versions == pair {
			return
		}
	}
	m.decisions = append(m.decisions, MatchDecision{
		Signal:     prefix,
		Kind:       kind,
		Raw:        raw,
		Normalized: normalized,
		Versions:   pair,
	})
}

// Add ingests one entry and links it to existing versions through every
// identity signal it carries.
func (m *Merger) Add(entry Entry) {
	seq := len(m.states) + 1
	index := seq - 1

	strong, bridges, digestKey, evidence := m.extractSignals(entry)
	adjudicated, issues := m.parseDates(entry)

	version := &Version{
		Sequence:        seq,
		Entry:           entry,
		Evidence:        evidence,
		AdjudicatedTime: adjudicated,
		DateIssues:      issues,
	}
	state := &versionState{
		version:   version,
		strong:    strong,
		bridges:   bridges,
		digestKey: digestKey,
	}
	m.states = append(m.states, state)
	m.parents = append(m.parents, index)
	m.ranks = append(m.ranks, 0)

	// Strong signals (Atom id, opaque guid, normalized permalink/canonical
	// URL) always join entries regardless of body differences; the resulting
	// body divergence is reported as a content conflict instead of overwrite.
	for _, signal := range strong {
		prefix, kind, raw, normalized := decodeSignal(signal)
		if owner, ok := m.strongOwn[signal]; ok {
			root := m.union(index, owner)
			m.strongOwn[signal] = root
			m.recordDecision(seq, owner+1, prefix, kind, raw, normalized)
		} else {
			m.strongOwn[signal] = m.find(index)
			m.recordDecision(seq, seq, prefix, kind, raw, normalized)
		}
	}

	// Domain-migration bridges ignore host and scheme but require the same
	// content digest, so a moved article keeps its chain while unrelated
	// articles that happen to share a path are not merged.
	for _, bridge := range bridges {
		if owner, ok := m.bridgeOwn[bridge.key]; ok {
			if m.states[owner].digestKey == digestKey {
				root := m.union(index, owner)
				m.bridgeOwn[bridge.key] = root
				m.recordDecision(seq, owner+1, prefixBridge, sigBridge, bridge.raw, stripPrefix(bridge.key))
			}
		} else {
			m.bridgeOwn[bridge.key] = m.find(index)
		}
	}

	// Content digest is the weakest signal: it only connects entries that
	// carry no strong identity of their own (e.g. guid-less RSS items).
	if len(strong) == 0 {
		if owner, ok := m.digestOwn[digestKey]; ok {
			root := m.union(index, owner)
			m.digestOwn[digestKey] = root
			m.recordDecision(seq, owner+1, prefixDigest, sigDigest,
				entry.Summary+"\x00"+entry.Content, stripPrefix(digestKey))
		} else {
			m.digestOwn[digestKey] = m.find(index)
		}
	}
}

func stripPrefix(key string) string {
	if idx := strings.Index(key, ":"); idx >= 0 {
		return key[idx+1:]
	}
	return key
}

// decodeSignal splits an internal key into its evidence components.
func decodeSignal(signal string) (prefix, kind, raw, normalized string) {
	idx := strings.Index(signal, ":")
	if idx < 0 {
		return signal, signal, "", signal
	}
	prefix = signal[:idx+1]
	normalized = signal[idx+1:]
	switch prefix {
	case prefixAtomID:
		kind = sigAtomID
	case prefixOpaque:
		kind = sigOpaque
	case prefixURL:
		kind = sigURL
	case prefixBridge:
		kind = sigBridge
	case prefixDigest:
		kind = sigDigest
	default:
		kind = prefix
	}
	raw = normalized
	return prefix, kind, raw, normalized
}

// extractSignals computes the identity signals and field evidence for an
// entry.
func (m *Merger) extractSignals(entry Entry) (strong []string, bridges []bridgeSignal, digestKey string, evidence FieldEvidence) {
	evidence = FieldEvidence{
		AtomID:     entry.AtomID,
		GUIDValue:  entry.GUID.Value,
		GUIDKind:   entry.GUID.Kind,
		AllLinks:   append([]Link(nil), entry.Links...),
		LegacyLink: entry.Link,
		Title:      entry.Title,
		Published:  entry.Published,
		Updated:    entry.Updated,
		Summary:    entry.Summary,
		Content:    entry.Content,
	}
	digestKey = prefixDigest + contentDigest(entry.Summary, entry.Content)
	evidence.ContentDigest = stripPrefix(digestKey)

	if trimmed := strings.TrimSpace(entry.AtomID); trimmed != "" {
		strong = append(strong, prefixAtomID+trimmed)
	}

	// A permalink guid is identity by URL; an opaque guid is identity by
	// token and must never be parsed as a URL.
	if trimmed := strings.TrimSpace(entry.GUID.Value); trimmed != "" {
		switch entry.GUID.Kind {
		case GUIDKindPermalink:
			if normalized, ok := m.normalizeURL(trimmed, entry.FeedURL); ok {
				strong = append(strong, prefixURL+normalized)
				evidence.PermalinkRawHref = trimmed
				evidence.CanonicalHref = normalized
			}
		default:
			strong = append(strong, prefixOpaque+trimmed)
		}
	}

	rawHref := selectCanonicalLink(entry)
	if rawHref != "" {
		if normalized, ok := m.normalizeURL(rawHref, entry.FeedURL); ok {
			key := prefixURL + normalized
			if !containsString(strong, key) {
				strong = append(strong, key)
			}
			if evidence.CanonicalHref == "" {
				evidence.PermalinkRawHref = rawHref
				evidence.CanonicalHref = normalized
			}
			if bridgeKey, ok := bridgeKeyFor(normalized); ok {
				bridges = append(bridges, bridgeSignal{key: prefixBridge + bridgeKey, raw: rawHref})
			}
		}
	}

	return strong, bridges, digestKey, evidence
}

// selectCanonicalLink picks the best permanent link: an explicitly canonical
// link first, then an Atom alternate, then the first plain link, then the
// legacy RSS <link>.
func selectCanonicalLink(entry Entry) string {
	for _, link := range entry.Links {
		if link.Canonical && strings.TrimSpace(link.Href) != "" {
			return link.Href
		}
	}
	for _, link := range entry.Links {
		if strings.EqualFold(strings.TrimSpace(link.Rel), "alternate") && strings.TrimSpace(link.Href) != "" {
			return link.Href
		}
	}
	for _, link := range entry.Links {
		if strings.TrimSpace(link.Rel) == "" && strings.TrimSpace(link.Href) != "" {
			return link.Href
		}
	}
	if len(entry.Links) > 0 && strings.TrimSpace(entry.Links[0].Href) != "" {
		return entry.Links[0].Href
	}
	return strings.TrimSpace(entry.Link)
}

// normalizeURL resolves href against the feed URL and returns a canonical
// absolute http(s) URL with tracking parameters removed.
func (m *Merger) normalizeURL(href, feedURL string) (string, bool) {
	resolved := strings.TrimSpace(href)
	if resolved == "" {
		return "", false
	}
	if base, err := url.Parse(strings.TrimSpace(feedURL)); err == nil && base != nil {
		if ref, err := url.Parse(resolved); err == nil {
			resolved = base.ResolveReference(ref).String()
		}
	}
	parsed, err := url.Parse(resolved)
	if err != nil || parsed.Host == "" {
		return "", false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", false
	}
	host := strings.ToLower(parsed.Hostname())
	path := parsed.EscapedPath()
	if path == "" {
		path = "/"
	}
	path = strings.TrimSuffix(path, "/")
	if path == "" {
		path = "/"
	}
	query := parsed.Query()
	for param := range m.strip {
		query.Del(param)
	}
	keys := make([]string, 0, len(query))
	for key := range query {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		values := append([]string(nil), query[key]...)
		sort.Strings(values)
		for _, value := range values {
			parts = append(parts, url.QueryEscape(key)+"="+url.QueryEscape(value))
		}
	}
	normalized := parsed.Scheme + "://" + host
	if port := parsed.Port(); port != "" {
		normalized += ":" + port
	}
	normalized += path
	if len(parts) > 0 {
		normalized += "?" + strings.Join(parts, "&")
	}
	if fragment := parsed.Fragment; fragment != "" {
		normalized += "#" + fragment
	}
	return normalized, true
}

// bridgeKeyFor drops scheme and host from a normalized URL, keeping the path
// and query so domain migration can be detected.
func bridgeKeyFor(normalized string) (string, bool) {
	parsed, err := url.Parse(normalized)
	if err != nil || parsed.Host == "" {
		return "", false
	}
	path := parsed.EscapedPath()
	if path == "" || path == "/" {
		return "", false
	}
	key := path
	if parsed.RawQuery != "" {
		key += "?" + parsed.RawQuery
	}
	if parsed.Fragment != "" {
		key += "#" + parsed.Fragment
	}
	return key, true
}

// contentDigest fingerprints the body. Whitespace is collapsed first so
// immaterial formatting churn does not look like new content.
func contentDigest(summary, content string) string {
	normalizedSummary := whitespaceRun.ReplaceAllString(strings.TrimSpace(summary), " ")
	normalizedContent := whitespaceRun.ReplaceAllString(strings.TrimSpace(content), " ")
	sum := sha256.Sum256([]byte(normalizedSummary + "\x00" + normalizedContent))
	return hex.EncodeToString(sum[:])
}

// normalizeText collapses whitespace for title comparison.
func normalizeText(value string) string {
	return whitespaceRun.ReplaceAllString(strings.TrimSpace(value), " ")
}

// parseDates parses the raw date fields. Updated is preferred over Published
// for adjudication. Every unparseable field is returned as a DateIssue and
// parsing failure never contributes a zero time.
// parseDates parses the raw date fields. Updated is preferred over Published
// for adjudication. Every unparseable field is returned as a DateIssue and
// parsing failure never contributes a zero time, so undated entries cannot
// win a newer/older decision.
func (m *Merger) parseDates(entry Entry) (*time.Time, []DateIssue) {
	var issues []DateIssue
	parsedUpdated, updatedIssue := m.parseOneDate("updated", entry.Updated)
	parsedPublished, publishedIssue := m.parseOneDate("published", entry.Published)
	if updatedIssue != nil {
		issues = append(issues, *updatedIssue)
	}
	if publishedIssue != nil {
		issues = append(issues, *publishedIssue)
	}
	if parsedUpdated != nil {
		return parsedUpdated, issues
	}
	return parsedPublished, issues
}

// parseOneDate parses one raw field, returning either a time or an issue.
// Empty fields produce neither a time nor an issue.
func (m *Merger) parseOneDate(field, raw string) (*time.Time, *DateIssue) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, nil
	}
	for _, layout := range m.formats {
		if parsed, err := time.Parse(layout, trimmed); err == nil {
			candidate := parsed
			return &candidate, nil
		}
	}
	return nil, &DateIssue{
		Field:    field,
		RawValue: raw,
		Err:      "no matching date layout for " + trimmed,
	}
}

// Chains finalizes the ingested entries into ordered identity chains.
func (m *Merger) Chains() []*Chain {
	groups := make(map[int][]*versionState)
	for _, state := range m.states {
		root := m.find(state.version.Sequence - 1)
		groups[root] = append(groups[root], state)
	}

	roots := make([]int, 0, len(groups))
	for root := range groups {
		roots = append(roots, root)
	}
	sort.Slice(roots, func(i, j int) bool {
		return groups[roots[i]][0].version.Sequence < groups[roots[j]][0].version.Sequence
	})

	chains := make([]*Chain, 0, len(roots))
	for _, root := range roots {
		chains = append(chains, m.buildChain(groups[root]))
	}
	return chains
}

func (m *Merger) buildChain(states []*versionState) *Chain {
	sort.Slice(states, func(i, j int) bool {
		return states[i].version.Sequence < states[j].version.Sequence
	})

	chain := &Chain{}
	versions := make([]*Version, 0, len(states))
	seenDigests := make(map[string]struct{})
	digestsInOrder := make([]string, 0)

	for _, state := range states {
		version := state.version
		version.Matches = m.matchesFor(version.Sequence)
		versions = append(versions, version)

		if _, ok := seenDigests[version.Evidence.ContentDigest]; !ok {
			seenDigests[version.Evidence.ContentDigest] = struct{}{}
			digestsInOrder = append(digestsInOrder, version.Evidence.ContentDigest)
		}
	}

	// Per-version change labels and duplicate flags, comparing consecutive
	// observations so nothing is silently overwritten.
	for i, version := range versions {
		if i == 0 {
			version.Changes = []ChangeKind{ChangeFirstSeen}
			continue
		}
		previous := versions[i-1]
		kinds := m.describeChanges(previous, version)
		version.Changes = kinds
		if version.Evidence.ContentDigest == previous.Evidence.ContentDigest &&
			normalizeText(version.Entry.Title) == normalizeText(previous.Entry.Title) {
			version.Duplicate = true
		}
	}

	chain.Versions = versions
	chain.DistinctDigests = digestsInOrder
	chain.Matches = m.matchesForSet(versions)
	chain.Basis = m.strongestBasis(versions)
	chain.ID = chain.Basis.Signal + chain.Basis.Normalized

	chain.RankedVersions = versionsWithDates(versions)
	sort.SliceStable(chain.RankedVersions, func(i, j int) bool {
		return chain.RankedVersions[i].AdjudicatedTime.After(*chain.RankedVersions[j].AdjudicatedTime)
	})
	if len(chain.RankedVersions) > 0 {
		chain.Latest = chain.RankedVersions[0]
	}

	chain.ChangeHistory = buildChangeHistory(versions)
	chain.ContentConflicts = buildConflicts(versions, digestsInOrder)
	return chain
}

// describeChanges diffs two consecutive versions.
func (m *Merger) describeChanges(previous, current *Version) []ChangeKind {
	kinds := make([]ChangeKind, 0, 3)
	if normalizeText(previous.Entry.Title) != normalizeText(current.Entry.Title) {
		kinds = append(kinds, ChangeTitleUpdated)
	}
	if previous.Evidence.ContentDigest != current.Evidence.ContentDigest {
		kinds = append(kinds, ChangeContentUpdated)
	}
	if prevHost, curHost := hostOf(previous.Evidence.CanonicalHref), hostOf(current.Evidence.CanonicalHref); prevHost != "" && curHost != "" && prevHost != curHost {
		kinds = append(kinds, ChangeDomainMigrated)
	}
	if len(kinds) == 0 {
		kinds = append(kinds, ChangeUnchanged)
	}
	return kinds
}

func hostOf(raw string) string {
	if raw == "" {
		return ""
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return strings.ToLower(parsed.Hostname())
}

func versionsWithDates(versions []*Version) []*Version {
	ranked := make([]*Version, 0, len(versions))
	for _, version := range versions {
		if version.AdjudicatedTime != nil {
			ranked = append(ranked, version)
		}
	}
	return ranked
}

func buildChangeHistory(versions []*Version) []ChangeRecord {
	history := make([]ChangeRecord, 0, len(versions))
	for i, version := range versions {
		if i == 0 {
			continue
		}
		history = append(history, ChangeRecord{
			FromVersion: versions[i-1].Sequence,
			ToVersion:   version.Sequence,
			Kinds:       append([]ChangeKind(nil), version.Changes...),
		})
	}
	return history
}

// buildConflicts turns distinct bodies under one identity into explicit
// conflict records instead of dropping the older body.
func buildConflicts(versions []*Version, digests []string) []ContentConflict {
	if len(digests) <= 1 {
		return nil
	}
	byDigest := make(map[string][]int)
	for _, version := range versions {
		digest := version.Evidence.ContentDigest
		byDigest[digest] = append(byDigest[digest], version.Sequence)
	}
	conflicts := make([]ContentConflict, 0, len(digests))
	for _, digest := range digests {
		conflicts = append(conflicts, ContentConflict{
			Versions: append([]int(nil), byDigest[digest]...),
			Digests:  []string{digest},
			Reason:   "shared identity with differing content; no body was overwritten",
		})
	}
	return conflicts
}

// matchesFor returns the decisions where the given sequence is an endpoint.
func (m *Merger) matchesFor(seq int) []MatchDecision {
	out := make([]MatchDecision, 0)
	for _, decision := range m.decisions {
		if decision.Versions[0] == seq || decision.Versions[1] == seq {
			out = append(out, decision)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Versions[1] != out[j].Versions[1] {
			return out[i].Versions[1] < out[j].Versions[1]
		}
		return signalRank(out[i].Signal) < signalRank(out[j].Signal)
	})
	return out
}

// matchesForSet returns the full evidence graph touching a chain.
func (m *Merger) matchesForSet(versions []*Version) []MatchDecision {
	members := make(map[int]struct{}, len(versions))
	for _, version := range versions {
		members[version.Sequence] = struct{}{}
	}
	out := make([]MatchDecision, 0)
	for _, decision := range m.decisions {
		if _, okA := members[decision.Versions[0]]; okA {
			if _, okB := members[decision.Versions[1]]; okB {
				out = append(out, decision)
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Versions[0] != out[j].Versions[0] {
			return out[i].Versions[0] < out[j].Versions[0]
		}
		if out[i].Versions[1] != out[j].Versions[1] {
			return out[i].Versions[1] < out[j].Versions[1]
		}
		return signalRank(out[i].Signal) < signalRank(out[j].Signal)
	})
	return out
}

// strongestBasis selects the defining signal of the chain using the priority
// Atom id > opaque guid > permalink URL > bridge > digest.
func (m *Merger) strongestBasis(versions []*Version) IdentityBasis {
	best := IdentityBasis{
		Signal: prefixDigest,
		Kind:   sigDigest,
	}
	bestRank := signalRank(prefixDigest)
	bestFoundingSeq := versions[0].Sequence
	for _, decision := range m.matchesForSet(versions) {
		rank := signalRank(decision.Signal)
		earlier := decision.Versions[0] < bestFoundingSeq
		if rank < bestRank || (rank == bestRank && earlier) {
			best = IdentityBasis{
				Signal:     decision.Signal,
				Kind:       decision.Kind,
				Raw:        decision.Raw,
				Normalized: decision.Normalized,
			}
			bestRank = rank
			bestFoundingSeq = decision.Versions[0]
		}
	}
	if best.Normalized == "" && len(versions) > 0 {
		best.Normalized = versions[0].Evidence.ContentDigest
		best.Raw = versions[0].Evidence.Summary + "\x00" + versions[0].Evidence.Content
	}
	return best
}

func signalRank(prefix string) int {
	switch prefix {
	case prefixAtomID:
		return 0
	case prefixOpaque:
		return 1
	case prefixURL:
		return 2
	case prefixBridge:
		return 3
	case prefixDigest:
		return 4
	default:
		return 5
	}
}

func containsString(items []string, target string) bool {
	for _, item := range items {
		if item == target {
			return true
		}
	}
	return false
}

// Merge ingests all entries and returns the finalized identity chains in
// first-seen order.
func Merge(entries []Entry, opts *MergerOptions) []*Chain {
	merger := NewMerger(opts)
	for _, entry := range entries {
		merger.Add(entry)
	}
	return merger.Chains()
}
