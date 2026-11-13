package dataeng

import (
	"fmt"
	"sort"
	"sync"
	"time"
)

// Store is the generation-aware NetFlow/IPFIX template registry and pending
// data-set buffer. It is safe for concurrent use.
//
// Wire processing follows a simple rule: the registry is snapshotted when a
// packet is received. Templates carried by that packet are installed only
// after all of its data sets have been handled, so a refresh can never change
// the interpretation of an already received packet. Data sets for which no
// active template exists are retained in a bounded FIFO until a matching
// template arrives.
type Store struct {
	mu sync.Mutex

	cfg        Config
	generation uint64

	templates       map[TemplateKey]Template
	optionTemplates map[TemplateKey]Template
	revisions       map[TemplateKey]uint64

	pending      []*pendingItem
	pendingBytes int

	stats Stats
}

type pendingItem struct {
	key               TemplateKey
	version           uint16
	sequence          uint32
	exportTime        time.Time
	sysUptime         uint32
	receivedAt        time.Time
	receiveGeneration uint64
	payload           []byte
}

// TemplateStore is an alias for Store.
type TemplateStore = Store

// Registry is an alias for Store.
type Registry = Store

// TemplateRegistry is an alias for Store.
type TemplateRegistry = Store

// NewStore creates a template store. It accepts Config values, *Config values
// and Option functions; with no arguments it uses safe bounded defaults.
func NewStore(settings ...any) *Store {
	return newStore(newConfig(settings))
}

// New is an alias for NewStore.
func New(settings ...any) *Store {
	return NewStore(settings...)
}

// NewTemplateStore is an alias for NewStore.
func NewTemplateStore(settings ...any) *Store {
	return NewStore(settings...)
}

// NewRegistry is an alias for NewStore.
func NewRegistry(settings ...any) *Store {
	return NewStore(settings...)
}

// NewStoreWithConfig creates a store from a Config value.
func NewStoreWithConfig(cfg Config) *Store {
	return newStore(newConfig([]any{cfg}))
}

func newStore(cfg Config) *Store {
	return &Store{
		cfg:             cfg,
		templates:       make(map[TemplateKey]Template),
		optionTemplates: make(map[TemplateKey]Template),
		revisions:       make(map[TemplateKey]uint64),
	}
}

// Generation returns the most recently issued receive generation.
func (s *Store) Generation() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.generation
}

// RegisterTemplate installs a template outside wire packet processing. The
// template becomes effective immediately. Pending data sets that match it are
// returned in their original receive order.
func (s *Store) RegisterTemplate(exporter any, domain uint32, tmpl Template) ([]DataSet, error) {
	exp := NewExporter(exporter)
	if exp.Address == "" {
		exp = NewExporter(tmpl.Exporter)
	}
	if tmpl.ID == 0 && tmpl.TemplateID != 0 {
		tmpl.ID = tmpl.TemplateID
	}
	tmpl.TemplateID = tmpl.ID

	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.cfg.Clock()
	s.expireLocked(now)
	s.generation++
	gen := s.generation

	tmpl.Exporter = exp
	tmpl.ObservationDomain = domain
	if err := s.installTemplateLocked(tmpl, gen, gen, now); err != nil {
		return nil, err
	}

	updated := map[TemplateKey]struct{}{
		{Exporter: exp, ObservationDomain: domain, TemplateID: tmpl.ID}: {},
	}
	return s.resolvePendingLocked(updated, gen, now), nil
}

// AddTemplate is an alias for RegisterTemplate.
func (s *Store) AddTemplate(exporter any, domain uint32, tmpl Template) ([]DataSet, error) {
	return s.RegisterTemplate(exporter, domain, tmpl)
}

// InstallTemplate installs a template using an explicit registry key.
func (s *Store) InstallTemplate(key TemplateKey, tmpl Template) ([]DataSet, error) {
	if key.TemplateID == 0 {
		key.TemplateID = tmpl.ID
	}
	tmpl.ID = key.TemplateID
	tmpl.Exporter = key.Exporter
	tmpl.ObservationDomain = key.ObservationDomain
	return s.RegisterTemplate(key.Exporter, key.ObservationDomain, tmpl)
}

func (s *Store) installTemplateLocked(tmpl Template, generation, effectiveGeneration uint64, now time.Time) error {
	if tmpl.ID == 0 && tmpl.TemplateID != 0 {
		tmpl.ID = tmpl.TemplateID
	}
	tmpl.TemplateID = tmpl.ID
	if tmpl.Kind != TemplateData && tmpl.Kind != TemplateOptions {
		return fmt.Errorf("%w: unknown kind %d", ErrInvalidTemplate, uint8(tmpl.Kind))
	}
	if len(tmpl.Fields) == 0 {
		return fmt.Errorf("%w: template %d has no fields", ErrInvalidTemplate, tmpl.ID)
	}
	if tmpl.ScopeFieldCount < 0 || tmpl.ScopeFieldCount > len(tmpl.Fields) {
		return fmt.Errorf("%w: invalid scope field count %d", ErrInvalidTemplate, tmpl.ScopeFieldCount)
	}
	for _, f := range tmpl.Fields {
		if f.Length == 0 {
			return fmt.Errorf("%w: field %d has zero length", ErrInvalidTemplate, f.Type)
		}
	}

	tmpl.Exporter = canonicalExporter(tmpl.Exporter)
	tmpl.Fields = append([]Field(nil), tmpl.Fields...)
	tmpl.Generation = generation
	tmpl.EffectiveGeneration = effectiveGeneration
	tmpl.ReceivedAt = now
	if ttl := s.cfg.templateTTL(tmpl.Kind); ttl > 0 {
		tmpl.ExpiresAt = now.Add(ttl)
	}

	key := tmpl.Key()
	s.revisions[key]++
	tmpl.Revision = s.revisions[key]

	if tmpl.Kind == TemplateOptions {
		s.optionTemplates[key] = tmpl
		s.stats.OptionTemplateUpdates++
	} else {
		s.templates[key] = tmpl
		s.stats.TemplateUpdates++
	}
	return nil
}

// Receive parses a NetFlow v9 or IPFIX packet and returns all data sets that
// became deliverable as a result. Data sets with no active template are queued
// (subject to the configured bounds) and are not returned.
//
// Templates in packet P can only be used by packets received after P. Any
// queued data sets from earlier packets that match a template first seen in P
// are returned before data sets decoded directly from P, preserving the
// original receive order of the queued items.
//
// A malformed packet returns a ParseError (wrapping ErrMalformedPacket) and
// does not mutate template state. Decoding errors caused by a payload that is
// inconsistent with an active template do not prevent template installation;
// the affected data set is skipped and the first such error is returned.
func (s *Store) Receive(exporter any, packet []byte) ([]DataSet, error) {
	exp := NewExporter(exporter)

	s.mu.Lock()
	defer s.mu.Unlock()

	s.stats.PacketsReceived++
	parsed, err := parsePacket(packet)
	if err != nil {
		s.stats.PacketsMalformed++
		return nil, err
	}

	now := s.cfg.Clock()
	s.expireLocked(now)
	s.generation++
	parsedGeneration := s.generation

	// Snapshot before installing anything from this packet. Template values
	// include field slices that are replaced, never mutated in place.
	dataSnapshot := cloneTemplateMap(s.templates)
	optionSnapshot := cloneTemplateMap(s.optionTemplates)

	var (
		immediate []DataSet
		firstErr  error
	)

	for _, raw := range parsed.dataSets {
		key := TemplateKey{
			Exporter:          exp,
			ObservationDomain: parsed.domain,
			TemplateID:        raw.id,
		}
		s.stats.DataSetsReceived++

		tmpl, ok := lookupTemplate(dataSnapshot, optionSnapshot, key)
		if !ok {
			item := &pendingItem{
				key:               key,
				version:           parsed.version,
				sequence:          parsed.sequence,
				exportTime:        parsed.exportTime,
				sysUptime:         parsed.sysUptime,
				receivedAt:        now,
				receiveGeneration: parsedGeneration,
				payload:           append([]byte(nil), raw.payload...),
			}
			if s.enqueueLocked(item) {
				s.stats.DataSetsQueued++
			}
			continue
		}

		records, decodeErr := decodeRecords(tmpl, raw.payload)
		if decodeErr != nil {
			s.stats.DecodeErrors++
			if firstErr == nil {
				firstErr = fmt.Errorf("dataeng: template %d: %w", raw.id, decodeErr)
			}
			continue
		}

		s.stats.DataSetsDecoded++
		s.stats.RecordsDecoded += uint64(len(records))
		immediate = append(immediate, dataSetFromRecords(
			key,
			tmpl,
			parsed.version,
			parsed.sequence,
			parsed.exportTime,
			parsed.sysUptime,
			now,
			parsedGeneration,
			false,
			raw.payload,
			records,
		))
	}

	updated := make(map[TemplateKey]struct{}, len(parsed.templates))
	for _, tmpl := range parsed.templates {
		tmpl.Exporter = exp
		tmpl.ObservationDomain = parsed.domain
		tmpl.Version = parsed.version
		if err := s.installTemplateLocked(tmpl, parsedGeneration, parsedGeneration+1, now); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		updated[tmpl.Key()] = struct{}{}
	}

	for _, withdrawal := range parsed.withdrawals {
		s.withdrawLocked(exp, parsed.domain, withdrawal)
	}

	// Only data sets received before this packet may be resolved by templates
	// installed from it. resolvePendingLocked checks receiveGeneration.
	resolved := s.resolvePendingLocked(updated, parsedGeneration, now)
	result := make([]DataSet, 0, len(resolved)+len(immediate))
	result = append(result, resolved...)
	result = append(result, immediate...)

	if firstErr != nil {
		return result, firstErr
	}
	return result, nil
}

func (s *Store) withdrawLocked(exporter Exporter, domain uint32, withdrawal templateWithdrawal) {
	if withdrawal.all {
		target := s.templates
		if withdrawal.kind == TemplateOptions {
			target = s.optionTemplates
		}
		for key := range target {
			if key.Exporter == exporter && key.ObservationDomain == domain {
				delete(target, key)
			}
		}
		s.stats.TemplatesWithdrawn++
		return
	}

	key := TemplateKey{
		Exporter:          exporter,
		ObservationDomain: domain,
		TemplateID:        withdrawal.id,
	}
	if withdrawal.kind == TemplateOptions {
		if _, ok := s.optionTemplates[key]; ok {
			delete(s.optionTemplates, key)
			s.stats.TemplatesWithdrawn++
		}
		return
	}
	if _, ok := s.templates[key]; ok {
		delete(s.templates, key)
		s.stats.TemplatesWithdrawn++
	}
}

// Process is an alias for Receive.
func (s *Store) Process(exporter any, packet []byte) ([]DataSet, error) {
	return s.Receive(exporter, packet)
}

// ProcessPacket is an alias for Receive.
func (s *Store) ProcessPacket(exporter any, packet []byte) ([]DataSet, error) {
	return s.Receive(exporter, packet)
}

// ReceivePacket is an alias for Receive.
func (s *Store) ReceivePacket(exporter any, packet []byte) ([]DataSet, error) {
	return s.Receive(exporter, packet)
}

// Ingest is an alias for Receive.
func (s *Store) Ingest(exporter any, packet []byte) ([]DataSet, error) {
	return s.Receive(exporter, packet)
}

// HandlePacket is an alias for Receive.
func (s *Store) HandlePacket(exporter any, packet []byte) ([]DataSet, error) {
	return s.Receive(exporter, packet)
}

func (s *Store) enqueueLocked(item *pendingItem) bool {
	size := len(item.payload)
	maxCount := s.cfg.MaxPending
	maxBytes := s.cfg.MaxPendingBytes

	overCount := maxCount >= 0 && len(s.pending) >= maxCount
	overBytes := maxBytes >= 0 && s.pendingBytes+size > maxBytes
	if !overCount && !overBytes {
		s.pending = append(s.pending, item)
		s.pendingBytes += size
		return true
	}

	if s.cfg.DropOldest {
		for len(s.pending) > 0 &&
			((maxCount >= 0 && len(s.pending) >= maxCount) ||
				(maxBytes >= 0 && s.pendingBytes+size > maxBytes)) {
			s.evictOldestLocked()
		}
		if (maxCount < 0 || len(s.pending) < maxCount) &&
			(maxBytes < 0 || s.pendingBytes+size <= maxBytes) {
			s.pending = append(s.pending, item)
			s.pendingBytes += size
			return true
		}
	}

	s.stats.DataSetsDropped++
	s.stats.PendingBytesDropped += uint64(size)
	return false
}

func (s *Store) evictOldestLocked() {
	oldest := s.pending[0]
	s.pending[0] = nil
	s.pending = s.pending[1:]
	s.pendingBytes -= len(oldest.payload)
	s.stats.DataSetsDropped++
	s.stats.PendingBytesDropped += uint64(len(oldest.payload))
}

func (s *Store) resolvePendingLocked(updated map[TemplateKey]struct{}, currentGeneration uint64, now time.Time) []DataSet {
	if len(updated) == 0 || len(s.pending) == 0 {
		return nil
	}

	out := make([]DataSet, 0)
	keep := s.pending[:0]
	for _, item := range s.pending {
		if item == nil {
			continue
		}

		if _, ok := updated[item.key]; !ok || item.receiveGeneration >= currentGeneration {
			keep = append(keep, item)
			continue
		}

		tmpl, ok := lookupTemplate(s.templates, s.optionTemplates, item.key)
		if !ok {
			keep = append(keep, item)
			continue
		}

		records, err := decodeRecords(tmpl, item.payload)
		if err != nil {
			s.stats.DecodeErrors++
			s.stats.DataSetsDropped++
			s.stats.PendingBytesDropped += uint64(len(item.payload))
			s.pendingBytes -= len(item.payload)
			continue
		}

		s.stats.DataSetsDecoded++
		s.stats.DataSetsResolved++
		s.stats.RecordsDecoded += uint64(len(records))
		s.pendingBytes -= len(item.payload)
		out = append(out, dataSetFromRecords(
			item.key,
			tmpl,
			item.version,
			item.sequence,
			item.exportTime,
			item.sysUptime,
			item.receivedAt,
			item.receiveGeneration,
			true,
			item.payload,
			records,
		))
	}

	for i := len(keep); i < len(s.pending); i++ {
		s.pending[i] = nil
	}
	s.pending = keep
	if s.pendingBytes < 0 {
		s.pendingBytes = 0
	}
	return out
}

func dataSetFromRecords(
	key TemplateKey,
	tmpl Template,
	version uint16,
	sequence uint32,
	exportTime time.Time,
	sysUptime uint32,
	receivedAt time.Time,
	receiveGeneration uint64,
	delayed bool,
	payload []byte,
	records []Record,
) DataSet {
	return DataSet{
		Exporter:           key.Exporter,
		ObservationDomain:  key.ObservationDomain,
		TemplateID:         key.TemplateID,
		Kind:               tmpl.Kind,
		Version:            version,
		Sequence:           sequence,
		ExportTime:         exportTime,
		SysUptime:          sysUptime,
		ReceiveGeneration:  receiveGeneration,
		TemplateGeneration: tmpl.Generation,
		TemplateRevision:   tmpl.Revision,
		ReceivedAt:         receivedAt,
		Delayed:            delayed,
		Raw:                append([]byte(nil), payload...),
		Records:            records,
	}
}

func cloneTemplateMap(src map[TemplateKey]Template) map[TemplateKey]Template {
	dst := make(map[TemplateKey]Template, len(src))
	for k, v := range src {
		dst[k] = v.Clone()
	}
	return dst
}

func lookupTemplate(regular, options map[TemplateKey]Template, key TemplateKey) (Template, bool) {
	if tmpl, ok := regular[key]; ok {
		return tmpl, true
	}
	tmpl, ok := options[key]
	return tmpl, ok
}

// LookupTemplate returns the active template for a key. A normal data
// template is preferred if both a data and an options template share an ID.
func (s *Store) LookupTemplate(exporter any, domain uint32, templateID uint16) (Template, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked(s.cfg.Clock())
	key := NewTemplateKey(exporter, domain, templateID)
	tmpl, ok := lookupTemplate(s.templates, s.optionTemplates, key)
	return tmpl.Clone(), ok
}

// Template is an alias for LookupTemplate.
func (s *Store) Template(exporter any, domain uint32, templateID uint16) (Template, bool) {
	return s.LookupTemplate(exporter, domain, templateID)
}

// DataTemplate returns the active normal data template for a key.
func (s *Store) DataTemplate(exporter any, domain uint32, templateID uint16) (Template, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked(s.cfg.Clock())
	tmpl, ok := s.templates[NewTemplateKey(exporter, domain, templateID)]
	return tmpl.Clone(), ok
}

// OptionTemplate returns the active options template for a key.
func (s *Store) OptionTemplate(exporter any, domain uint32, templateID uint16) (Template, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked(s.cfg.Clock())
	tmpl, ok := s.optionTemplates[NewTemplateKey(exporter, domain, templateID)]
	return tmpl.Clone(), ok
}

// Templates returns all active templates for an exporter and observation
// domain, ordered by kind and template ID.
func (s *Store) Templates(exporter any, domain uint32) []Template {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked(s.cfg.Clock())
	key := NewTemplateKey(exporter, domain, 0)
	var out []Template
	for k, tmpl := range s.templates {
		if k.Exporter == key.Exporter && k.ObservationDomain == domain {
			out = append(out, tmpl.Clone())
		}
	}
	for k, tmpl := range s.optionTemplates {
		if k.Exporter == key.Exporter && k.ObservationDomain == domain {
			out = append(out, tmpl.Clone())
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return out[i].Kind < out[j].Kind
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// AllTemplates returns every active template in registry order.
func (s *Store) AllTemplates() []Template {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked(s.cfg.Clock())
	out := make([]Template, 0, len(s.templates)+len(s.optionTemplates))
	for _, tmpl := range s.templates {
		out = append(out, tmpl.Clone())
	}
	for _, tmpl := range s.optionTemplates {
		out = append(out, tmpl.Clone())
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Exporter != out[j].Exporter {
			return out[i].Exporter.String() < out[j].Exporter.String()
		}
		if out[i].ObservationDomain != out[j].ObservationDomain {
			return out[i].ObservationDomain < out[j].ObservationDomain
		}
		if out[i].Kind != out[j].Kind {
			return out[i].Kind < out[j].Kind
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// RemoveTemplate removes one or both template kinds for a key. With no kind
// argument both the data and options registries are checked.
func (s *Store) RemoveTemplate(exporter any, domain uint32, templateID uint16, kind ...TemplateKind) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := NewTemplateKey(exporter, domain, templateID)
	removed := false
	removeBoth := len(kind) == 0
	for _, k := range kind {
		switch k {
		case TemplateData:
			if _, ok := s.templates[key]; ok {
				delete(s.templates, key)
				removed = true
			}
		case TemplateOptions:
			if _, ok := s.optionTemplates[key]; ok {
				delete(s.optionTemplates, key)
				removed = true
			}
		}
	}
	if removeBoth {
		if _, ok := s.templates[key]; ok {
			delete(s.templates, key)
			removed = true
		}
		if _, ok := s.optionTemplates[key]; ok {
			delete(s.optionTemplates, key)
			removed = true
		}
	}
	return removed
}

// DeleteTemplate is an alias for RemoveTemplate.
func (s *Store) DeleteTemplate(exporter any, domain uint32, templateID uint16, kind ...TemplateKind) bool {
	return s.RemoveTemplate(exporter, domain, templateID, kind...)
}

// Expire removes templates and pending data sets whose configured lifetimes
// have elapsed. It returns the number of templates removed. With no argument
// it uses the configured clock.
func (s *Store) Expire(now ...time.Time) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := s.cfg.Clock()
	if len(now) != 0 {
		t = now[0]
	}
	return s.expireLocked(t)
}

// ExpireTemplates is an alias for Expire.
func (s *Store) ExpireTemplates(now ...time.Time) int {
	return s.Expire(now...)
}

func (s *Store) expireLocked(now time.Time) int {
	removed := 0
	for key, tmpl := range s.templates {
		if tmpl.Expired(now) {
			delete(s.templates, key)
			removed++
		}
	}
	for key, tmpl := range s.optionTemplates {
		if tmpl.Expired(now) {
			delete(s.optionTemplates, key)
			removed++
		}
	}
	s.stats.TemplatesExpired += uint64(removed)

	if s.cfg.PendingTTL > 0 {
		keep := s.pending[:0]
		for _, item := range s.pending {
			if item == nil {
				continue
			}
			if !now.Before(item.receivedAt.Add(s.cfg.PendingTTL)) {
				s.pendingBytes -= len(item.payload)
				s.stats.PendingExpired++
				continue
			}
			keep = append(keep, item)
		}
		for i := len(keep); i < len(s.pending); i++ {
			s.pending[i] = nil
		}
		s.pending = keep
		if s.pendingBytes < 0 {
			s.pendingBytes = 0
		}
	}
	return removed
}

// DecodeDataSet decodes a raw data-set payload with the active template for
// the key. It does not guess a template and returns ErrNoTemplate if none is
// active.
func (s *Store) DecodeDataSet(exporter any, domain uint32, templateID uint16, payload []byte) ([]Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked(s.cfg.Clock())
	tmpl, ok := lookupTemplate(s.templates, s.optionTemplates, NewTemplateKey(exporter, domain, templateID))
	if !ok {
		return nil, ErrNoTemplate
	}
	return decodeRecords(tmpl, payload)
}

// DecodeOptionDataSet decodes a raw options-data payload using only the
// independently maintained options-template registry.
func (s *Store) DecodeOptionDataSet(exporter any, domain uint32, templateID uint16, payload []byte) ([]Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked(s.cfg.Clock())
	tmpl, ok := s.optionTemplates[NewTemplateKey(exporter, domain, templateID)]
	if !ok {
		return nil, ErrNoTemplate
	}
	return decodeRecords(tmpl, payload)
}

// Pending returns the number of data sets waiting for templates.
func (s *Store) Pending() int {
	return s.PendingCount()
}

// PendingCount returns the number of data sets waiting for templates.
func (s *Store) PendingCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked(s.cfg.Clock())
	return len(s.pending)
}

// PendingBytes returns the raw bytes retained in the waiting area.
func (s *Store) PendingBytes() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked(s.cfg.Clock())
	return s.pendingBytes
}

// PendingKeys returns the unique keys of queued data sets in first-received
// order.
func (s *Store) PendingKeys() []TemplateKey {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked(s.cfg.Clock())
	seen := make(map[TemplateKey]struct{}, len(s.pending))
	out := make([]TemplateKey, 0, len(s.pending))
	for _, item := range s.pending {
		if item == nil {
			continue
		}
		if _, ok := seen[item.key]; ok {
			continue
		}
		seen[item.key] = struct{}{}
		out = append(out, item.key)
	}
	return out
}

// DropPending clears the waiting area and returns the number of removed data
// sets.
func (s *Store) DropPending() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := len(s.pending)
	s.pending = nil
	s.pendingBytes = 0
	return n
}

// Stats returns a consistent snapshot of counters and current queue sizes.
func (s *Store) Stats() Stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked(s.cfg.Clock())
	stats := s.stats
	stats.Pending = len(s.pending)
	stats.PendingBytes = s.pendingBytes
	return stats
}

// Reset clears templates, queued data and counters. The receive-generation
// sequence continues monotonically.
func (s *Store) Reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.templates = make(map[TemplateKey]Template)
	s.optionTemplates = make(map[TemplateKey]Template)
	s.revisions = make(map[TemplateKey]uint64)
	s.pending = nil
	s.pendingBytes = 0
	s.stats = Stats{}
}
