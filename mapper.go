package formal

import (
	"errors"
	"fmt"
	"net/netip"
	"sort"
	"sync"
	"time"
)

// Defaults used when the corresponding Config field is zero.
const (
	DefaultPortMin         uint16 = 32768
	DefaultPortMax         uint16 = 60999
	DefaultUDPTimeout             = 30 * time.Second
	DefaultTCPTimeout             = 2 * time.Minute
	DefaultProtocolTimeout        = 30 * time.Second
)

// Errors returned by a Mapper.
var (
	ErrInvalidTuple    = errors.New("formal: invalid five-tuple")
	ErrNoFreePort      = errors.New("formal: no free external port")
	ErrTableFull       = errors.New("formal: session table is full")
	ErrInvalidConfig   = errors.New("formal: invalid configuration")
	ErrMalformedPacket = errors.New("formal: malformed packet")
	ErrNotICMPError    = errors.New("formal: packet is not an ICMP error")
)

// Config controls a Mapper.  The zero value is valid and uses the documented
// defaults.  PortMin and PortMax are inclusive.
type Config struct {
	// PortMin and PortMax delimit the external port pool (inclusive).  When
	// both are zero, DefaultPortMin and DefaultPortMax are used.  When only
	// PortMax is set, PortMin defaults to 1.
	PortMin uint16
	PortMax uint16

	// UDPTimeout is the idle timeout for UDP mappings.  A zero value selects
	// DefaultUDPTimeout.
	UDPTimeout time.Duration
	// TCPTimeout is the idle timeout for TCP mappings.  A zero value selects
	// DefaultTCPTimeout.
	TCPTimeout time.Duration
	// ProtocolTimeout applies to protocols other than TCP and UDP.  A zero
	// value selects DefaultProtocolTimeout.
	ProtocolTimeout time.Duration

	// MaxMappings limits the number of live mappings.  Zero means unlimited.
	MaxMappings int

	// ExternalIP optionally names the gateway address written into outbound
	// packets.  When set, an ICMP error carrying a post-NAT embedded packet is
	// accepted only if its source address is ExternalIP.
	ExternalIP netip.Addr

	// Clock supplies the current time for the convenience methods that do not
	// take an explicit timestamp.  A nil Clock means time.Now.
	Clock func() time.Time
}

// Mapping is an immutable snapshot of one live session mapping.
type Mapping struct {
	Tuple      Tuple
	Port       uint16
	Generation uint64
	Created    time.Time
	Updated    time.Time
	Expires    time.Time
}

// String implements fmt.Stringer.
func (m Mapping) String() string {
	return fmt.Sprintf("%s => port %d/gen %d (expires %s)", m.Tuple, m.Port, m.Generation, m.Expires)
}

// Key returns the identity of this mapping.  A key from an expired mapping
// can never release a newer mapping that reuses the same port.
func (m Mapping) Key() BindingKey {
	return BindingKey{Port: m.Port, Generation: m.Generation}
}

// BindingKey identifies one allocation of an external port.  Generations are
// monotonic and are never reused by a Mapper.
type BindingKey struct {
	Port       uint16
	Generation uint64
}

// Stats is a consistent snapshot of table accounting.  Using C for Created, A
// for Active, R for Removed, X for Expired, and I for ICMPRemoved, a healthy
// table always satisfies C == A + R + X + I.  Similarly,
// ICMPErrors == ICMPRemoved + ICMPIgnored.
type Stats struct {
	Active             int
	Created            uint64
	Refreshed          uint64
	Removed            uint64
	Expired            uint64
	ICMPErrors         uint64
	ICMPRemoved        uint64
	ICMPIgnored        uint64
	StaleReleases      uint64
	AllocationFailures uint64
	PortReuses         uint64
}

// Mapper is a concurrent session table.  All exported methods are safe for
// concurrent use and each operation is atomic with respect to the table.
type Mapper struct {
	mu sync.Mutex

	portMin  uint16
	portMax  uint16
	next     uint16
	used     []bool
	everUsed []bool

	udpTimeout      time.Duration
	tcpTimeout      time.Duration
	protocolTimeout time.Duration
	maxMappings     int
	externalIP      netip.Addr
	clock           func() time.Time

	byTuple map[Tuple]*binding
	byPort  map[uint16]*binding

	generation uint64
	stats      Stats
}

type binding struct {
	tuple      Tuple
	port       uint16
	generation uint64
	created    time.Time
	updated    time.Time
	expires    time.Time
}

func (b *binding) mapping() Mapping {
	return Mapping{
		Tuple:      b.tuple,
		Port:       b.port,
		Generation: b.generation,
		Created:    b.created,
		Updated:    b.updated,
		Expires:    b.expires,
	}
}

// New creates a Mapper.  Configuration errors are reported eagerly so that a
// packet-path caller never observes a partially initialized table.
func New(cfg Config) (*Mapper, error) {
	if cfg.PortMin == 0 {
		if cfg.PortMax == 0 {
			cfg.PortMin = DefaultPortMin
		} else {
			cfg.PortMin = 1
		}
	}
	if cfg.PortMax == 0 {
		cfg.PortMax = DefaultPortMax
	}
	if cfg.PortMin > cfg.PortMax {
		return nil, fmt.Errorf("%w: PortMin %d > PortMax %d", ErrInvalidConfig, cfg.PortMin, cfg.PortMax)
	}
	if cfg.UDPTimeout < 0 || cfg.TCPTimeout < 0 || cfg.ProtocolTimeout < 0 {
		return nil, fmt.Errorf("%w: timeouts must not be negative", ErrInvalidConfig)
	}
	if cfg.UDPTimeout == 0 {
		cfg.UDPTimeout = DefaultUDPTimeout
	}
	if cfg.TCPTimeout == 0 {
		cfg.TCPTimeout = DefaultTCPTimeout
	}
	if cfg.ProtocolTimeout == 0 {
		cfg.ProtocolTimeout = DefaultProtocolTimeout
	}
	if cfg.MaxMappings < 0 {
		return nil, fmt.Errorf("%w: MaxMappings must not be negative", ErrInvalidConfig)
	}
	if cfg.ExternalIP.IsValid() {
		cfg.ExternalIP = cfg.ExternalIP.Unmap()
	}
	if cfg.Clock == nil {
		cfg.Clock = time.Now
	}

	count := int(cfg.PortMax-cfg.PortMin) + 1
	return &Mapper{
		portMin:         cfg.PortMin,
		portMax:         cfg.PortMax,
		next:            cfg.PortMin,
		used:            make([]bool, count),
		everUsed:        make([]bool, count),
		udpTimeout:      cfg.UDPTimeout,
		tcpTimeout:      cfg.TCPTimeout,
		protocolTimeout: cfg.ProtocolTimeout,
		maxMappings:     cfg.MaxMappings,
		externalIP:      cfg.ExternalIP,
		clock:           cfg.Clock,
		byTuple:         make(map[Tuple]*binding),
		byPort:          make(map[uint16]*binding, count),
	}, nil
}

func (m *Mapper) now() time.Time {
	return m.clock()
}

func (m *Mapper) timeoutFor(protocol uint8) time.Duration {
	switch protocol {
	case ProtocolUDP:
		return m.udpTimeout
	case ProtocolTCP:
		return m.tcpTimeout
	default:
		return m.protocolTimeout
	}
}

func (m *Mapper) portIndex(port uint16) int {
	return int(port - m.portMin)
}

// Map returns the live mapping for t, creating one and allocating a port if
// necessary.  An existing live mapping is refreshed using its protocol's idle
// timeout.  The operation is atomic: a port cannot be handed to another
// five-tuple between expiry of t and creation of its replacement.
func (m *Mapper) Map(t Tuple) (Mapping, error) {
	return m.MapAt(t, m.now())
}

// MapAt is Map with an explicit timestamp.
func (m *Mapper) MapAt(t Tuple, now time.Time) (Mapping, error) {
	t, err := canonicalTuple(t)
	if err != nil {
		return Mapping{}, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if b := m.byTuple[t]; b != nil {
		if now.Before(b.expires) {
			m.refreshLocked(b, now)
			return b.mapping(), nil
		}
		m.removeLocked(b, removalExpired)
	}

	if m.maxMappings > 0 && len(m.byPort) >= m.maxMappings {
		// Expired entries do not consume capacity.  Reclaim them before
		// refusing a new flow.
		m.expireLocked(now)
	}
	if m.maxMappings > 0 && len(m.byPort) >= m.maxMappings {
		m.stats.AllocationFailures++
		return Mapping{}, ErrTableFull
	}
	port, ok := m.allocatePortLocked()
	if !ok {
		// A full port pool may still contain timed-out bindings.  Sweeping
		// here makes allocation pressure reclaim them atomically, so a
		// create racing with a timeout sweep either sees the old mapping or
		// a free port, never a false exhaustion.
		m.expireLocked(now)
		port, ok = m.allocatePortLocked()
	}
	if !ok {
		m.stats.AllocationFailures++
		return Mapping{}, ErrNoFreePort
	}

	m.generation++
	b := &binding{
		tuple:      t,
		port:       port,
		generation: m.generation,
		created:    now,
		updated:    now,
		expires:    now.Add(m.timeoutFor(t.Protocol)),
	}
	m.byTuple[t] = b
	m.byPort[port] = b
	m.stats.Created++
	return b.mapping(), nil
}

func (m *Mapper) refreshLocked(b *binding, now time.Time) {
	b.updated = now
	b.expires = now.Add(m.timeoutFor(b.tuple.Protocol))
	m.stats.Refreshed++
}

func (m *Mapper) allocatePortLocked() (uint16, bool) {
	count := int(m.portMax-m.portMin) + 1
	port := m.next
	for i := 0; i < count; i++ {
		if !m.used[m.portIndex(port)] {
			if m.byPort[port] != nil {
				panic("formal: allocator state disagrees with port map")
			}
			index := m.portIndex(port)
			reused := m.everUsed[index]
			m.used[index] = true
			m.everUsed[index] = true
			m.next = port + 1
			if port == m.portMax {
				m.next = m.portMin
			}
			if reused {
				m.stats.PortReuses++
			}
			return port, true
		}
		if m.byPort[port] == nil {
			panic("formal: allocator leaked a port")
		}
		port++
		if port > m.portMax { // uint16 wrap or past the end of the pool
			port = m.portMin
		}
	}
	return 0, false
}

// Lookup returns the mapping for t without refreshing its timeout.
func (m *Mapper) Lookup(t Tuple) (Mapping, bool) {
	return m.LookupAt(t, m.now())
}

// LookupAt is Lookup with an explicit timestamp.  If the mapping exists but
// has expired at now, it is reclaimed and reported as absent.
func (m *Mapper) LookupAt(t Tuple, now time.Time) (Mapping, bool) {
	t, err := canonicalTuple(t)
	if err != nil {
		return Mapping{}, false
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	b := m.byTuple[t]
	if b == nil {
		return Mapping{}, false
	}
	if !now.Before(b.expires) {
		m.removeLocked(b, removalExpired)
		return Mapping{}, false
	}
	return b.mapping(), true
}

// LookupPort returns the mapping that owns an external mapped port without
// refreshing it.  This is the inbound-packet direction used after a packet has
// been demultiplexed by its destination port.
func (m *Mapper) LookupPort(port uint16) (Mapping, bool) {
	return m.LookupPortAt(port, m.now())
}

// LookupPortAt is LookupPort with an explicit timestamp.
func (m *Mapper) LookupPortAt(port uint16, now time.Time) (Mapping, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	b := m.byPort[port]
	if b == nil {
		return Mapping{}, false
	}
	if !now.Before(b.expires) {
		m.removeLocked(b, removalExpired)
		return Mapping{}, false
	}
	return b.mapping(), true
}

// Refresh extends an existing mapping's idle timeout without creating a new
// one.  It is useful when the receive path counts inbound traffic as activity.
func (m *Mapper) Refresh(t Tuple) (Mapping, bool) {
	return m.RefreshAt(t, m.now())
}

// RefreshAt is Refresh with an explicit timestamp.
func (m *Mapper) RefreshAt(t Tuple, now time.Time) (Mapping, bool) {
	t, err := canonicalTuple(t)
	if err != nil {
		return Mapping{}, false
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	b := m.byTuple[t]
	if b == nil {
		return Mapping{}, false
	}
	if !now.Before(b.expires) {
		m.removeLocked(b, removalExpired)
		return Mapping{}, false
	}
	m.refreshLocked(b, now)
	return b.mapping(), true
}

// RefreshPort refreshes the mapping that owns port, if it is still live.
func (m *Mapper) RefreshPort(port uint16) (Mapping, bool) {
	return m.RefreshPortAt(port, m.now())
}

// RefreshPortAt is RefreshPort with an explicit timestamp.
func (m *Mapper) RefreshPortAt(port uint16, now time.Time) (Mapping, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	b := m.byPort[port]
	if b == nil {
		return Mapping{}, false
	}
	if !now.Before(b.expires) {
		m.removeLocked(b, removalExpired)
		return Mapping{}, false
	}
	m.refreshLocked(b, now)
	return b.mapping(), true
}

// Remove explicitly releases the mapping for t.  It returns false if no live
// mapping exists.
func (m *Mapper) Remove(t Tuple) bool {
	t, err := canonicalTuple(t)
	if err != nil {
		return false
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	b := m.byTuple[t]
	if b == nil {
		return false
	}
	m.removeLocked(b, removalExplicit)
	return true
}

// RemoveBinding releases a mapping only if key still names the current owner
// of its port.  A stale handle from a timed-out mapping therefore cannot
// release a newer mapping that reused the port.
func (m *Mapper) RemoveBinding(key BindingKey) bool {
	m.mu.Lock()
	defer m.mu.Unlock()

	b := m.byPort[key.Port]
	if b == nil || b.generation != key.Generation {
		m.stats.StaleReleases++
		return false
	}
	m.removeLocked(b, removalExplicit)
	return true
}

// Expire reclaims every mapping whose deadline is at or before now and
// returns the number reclaimed.  Each reclaimed mapping increments Expired
// exactly once.
func (m *Mapper) Expire(now time.Time) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.expireLocked(now)
}

func (m *Mapper) expireLocked(now time.Time) int {
	expired := 0
	for _, b := range m.byPort {
		if !now.Before(b.expires) {
			m.removeLocked(b, removalExpired)
			expired++
		}
	}
	return expired
}

// ExpireNow calls Expire with the configured clock.
func (m *Mapper) ExpireNow() int {
	return m.Expire(m.now())
}

type removalReason uint8

const (
	removalExplicit removalReason = iota
	removalExpired
	removalICMP
)

func (m *Mapper) removeLocked(b *binding, reason removalReason) {
	if m.byTuple[b.tuple] == b {
		delete(m.byTuple, b.tuple)
	}
	if m.byPort[b.port] == b {
		delete(m.byPort, b.port)
		m.used[m.portIndex(b.port)] = false
	}

	switch reason {
	case removalExpired:
		m.stats.Expired++
	case removalICMP:
		m.stats.ICMPRemoved++
	default:
		m.stats.Removed++
	}
}

// Stats returns a consistent accounting snapshot.
func (m *Mapper) Stats() Stats {
	m.mu.Lock()
	defer m.mu.Unlock()

	s := m.stats
	s.Active = len(m.byPort)
	return s
}

// Len returns the number of live mappings, including mappings whose deadline
// has passed but which have not yet been reclaimed.
func (m *Mapper) Len() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.byPort)
}

// Snapshot returns all current mappings sorted by external port.  Expired but
// not-yet-swept mappings are included; call Expire first for a live view.
func (m *Mapper) Snapshot() []Mapping {
	m.mu.Lock()
	defer m.mu.Unlock()

	out := make([]Mapping, 0, len(m.byPort))
	for _, b := range m.byPort {
		out = append(out, b.mapping())
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Port != out[j].Port {
			return out[i].Port < out[j].Port
		}
		return out[i].Generation < out[j].Generation
	})
	return out
}
