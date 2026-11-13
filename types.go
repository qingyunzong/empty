package dataeng

import (
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"time"
)

// Exporter identifies the device that exported a flow packet. Address is
// normally an IP address. Port is optional and is useful when a collector
// receives several independent streams from the same address.
type Exporter struct {
	Address string
	Port    uint16
}

// String returns the canonical representation of the exporter.
func (e Exporter) String() string {
	if e.Port == 0 {
		return e.Address
	}
	return net.JoinHostPort(e.Address, strconv.Itoa(int(e.Port)))
}

// NewExporter converts the common ways collectors represent a peer into an
// Exporter. It accepts Exporter, string, net.Addr, net.IP, net.IPAddr,
// netip.Addr, netip.AddrPort and fmt.Stringer values.
//
// Source ports are intentionally not part of a string or net.Addr identity:
// a NetFlow exporter is identified by its address, while its source port may
// change between packets. Use an Exporter value with an explicit Port when a
// port really is part of the identity.
func NewExporter(v any) Exporter {
	switch x := v.(type) {
	case Exporter:
		return canonicalExporter(x)
	case *Exporter:
		if x == nil {
			return Exporter{}
		}
		return canonicalExporter(*x)
	case string:
		return exporterFromString(x)
	case netip.Addr:
		if !x.IsValid() {
			return Exporter{}
		}
		return Exporter{Address: x.Unmap().String()}
	case netip.AddrPort:
		if !x.IsValid() {
			return Exporter{}
		}
		return Exporter{Address: x.Addr().Unmap().String(), Port: x.Port()}
	case net.IP:
		return exporterFromIP(x)
	case *net.IP:
		if x == nil {
			return Exporter{}
		}
		return exporterFromIP(*x)
	case net.IPAddr:
		return exporterFromIP(x.IP)
	case *net.IPAddr:
		if x == nil {
			return Exporter{}
		}
		return exporterFromIP(x.IP)
	case net.Addr:
		return exporterFromAddr(x)
	case fmt.Stringer:
		return exporterFromString(x.String())
	case nil:
		return Exporter{}
	default:
		return exporterFromString(fmt.Sprint(v))
	}
}

func canonicalExporter(e Exporter) Exporter {
	e.Address = strings.TrimSpace(e.Address)
	if e.Address == "" {
		return e
	}
	if addr, err := netip.ParseAddr(e.Address); err == nil {
		e.Address = addr.Unmap().String()
	}
	return e
}

func exporterFromString(s string) Exporter {
	s = strings.TrimSpace(s)
	if s == "" {
		return Exporter{}
	}
	if addr, err := netip.ParseAddr(s); err == nil {
		return Exporter{Address: addr.Unmap().String()}
	}
	if host, _, err := net.SplitHostPort(s); err == nil {
		// The source port is not part of an exporter identity.
		return exporterFromString(host)
	}
	return Exporter{Address: s}
}

func exporterFromIP(ip net.IP) Exporter {
	if ip == nil {
		return Exporter{}
	}
	if addr, ok := netip.AddrFromSlice(ip); ok {
		return Exporter{Address: addr.Unmap().String()}
	}
	return Exporter{Address: ip.String()}
}

func exporterFromAddr(addr net.Addr) Exporter {
	if addr == nil {
		return Exporter{}
	}
	switch x := addr.(type) {
	case *net.UDPAddr:
		return exporterFromIP(x.IP)
	case *net.TCPAddr:
		return exporterFromIP(x.IP)
	case *net.IPAddr:
		return exporterFromIP(x.IP)
	default:
		return exporterFromString(addr.String())
	}
}

// TemplateKey identifies a template version namespace. A template is selected
// by exporter, observation domain and template ID. Receive generations are
// tracked by Store; a refresh creates a new generation but never changes how
// packets that were already received are decoded.
type TemplateKey struct {
	Exporter          Exporter
	ObservationDomain uint32
	TemplateID        uint16
}

// NewTemplateKey constructs a TemplateKey from any value accepted by
// NewExporter.
func NewTemplateKey(exporter any, domain uint32, templateID uint16) TemplateKey {
	return TemplateKey{
		Exporter:          NewExporter(exporter),
		ObservationDomain: domain,
		TemplateID:        templateID,
	}
}

func (k TemplateKey) String() string {
	return fmt.Sprintf("%s/%d/%d", k.Exporter, k.ObservationDomain, k.TemplateID)
}

// TemplateKind distinguishes normal data templates from options templates.
// The two are stored and expired independently.
type TemplateKind uint8

const (
	// TemplateData is a normal NetFlow/IPFIX data template.
	TemplateData TemplateKind = iota
	// TemplateOptions is an IPFIX options template or NetFlow v9 option
	// template.
	TemplateOptions
)

const (
	// Short aliases for callers that prefer them.
	DataTemplate   = TemplateData
	OptionTemplate = TemplateOptions
)

func (k TemplateKind) String() string {
	switch k {
	case TemplateData:
		return "data"
	case TemplateOptions:
		return "options"
	default:
		return fmt.Sprintf("template-kind-%d", uint8(k))
	}
}

// Field describes one field in a template.
type Field struct {
	// Type is the IANA/NetFlow field type with the enterprise bit removed.
	Type uint16
	// Length is the field width in octets. 0xffff denotes an IPFIX
	// variable-length field.
	Length uint16
	// Enterprise is the IPFIX private enterprise number, or zero for an
	// IANA field.
	Enterprise uint32
}

// Variable reports whether the field uses IPFIX variable-length encoding.
func (f Field) Variable() bool { return f.Length == 0xffff }

// EnterpriseField reports whether the field has a private enterprise number.
func (f Field) EnterpriseField() bool { return f.Enterprise != 0 }

func (f Field) String() string {
	if f.Enterprise != 0 {
		return fmt.Sprintf("%d@%d/%d", f.Type, f.Enterprise, f.Length)
	}
	return fmt.Sprintf("%d/%d", f.Type, f.Length)
}

// Template is an immutable snapshot of a template revision.
type Template struct {
	Exporter          Exporter
	ObservationDomain uint32
	ID                uint16
	// TemplateID mirrors ID for callers that use the wire-format name.
	TemplateID      uint16
	Kind            TemplateKind
	Version         uint16
	Fields          []Field
	ScopeFieldCount int

	// Generation is the store generation in which this revision was
	// received. EffectiveGeneration is the first packet generation that may
	// use it. For wire packets these differ by one, enforcing the rule that
	// a template refresh only affects later packets.
	Generation          uint64
	EffectiveGeneration uint64
	// Revision is a monotonically increasing per-key revision number.
	Revision   uint64
	ReceivedAt time.Time
	ExpiresAt  time.Time
}

// Key returns the template's registry key.
func (t Template) Key() TemplateKey {
	return TemplateKey{
		Exporter:          t.Exporter,
		ObservationDomain: t.ObservationDomain,
		TemplateID:        t.ID,
	}
}

// Expired reports whether the template is expired at now. A zero ExpiresAt
// means that the template has no time-based expiry.
func (t Template) Expired(now time.Time) bool {
	return !t.ExpiresAt.IsZero() && !now.Before(t.ExpiresAt)
}

// Clone returns a deep copy of the template.
func (t Template) Clone() Template {
	t.Fields = append([]Field(nil), t.Fields...)
	return t
}

// IsOptions reports whether this is an options template.
func (t Template) IsOptions() bool { return t.Kind == TemplateOptions }

// RecordLength returns the fixed record length. When the template contains
// variable-length fields, fixed is false and the returned value is the sum of
// the fixed fields.
func (t Template) RecordLength() (length int, fixed bool) {
	fixed = true
	for _, f := range t.Fields {
		if f.Variable() {
			fixed = false
			continue
		}
		length += int(f.Length)
	}
	return length, fixed
}

// MinRecordLength returns the smallest possible encoded record length.
func (t Template) MinRecordLength() int {
	n := 0
	for _, f := range t.Fields {
		if f.Variable() {
			n++ // one-byte length prefix
			continue
		}
		n += int(f.Length)
	}
	return n
}

// Decode decodes data-set payload octets using this template. The payload
// must not include the four-octet set header.
func (t Template) Decode(data []byte) ([]Record, error) {
	return decodeRecords(t, data)
}

// FieldValue is one decoded field. Raw always contains the exact field octets;
// Value contains a convenience representation when the field type is known.
type FieldValue struct {
	Field Field
	Raw   []byte
	Value any
}

// Bytes returns a copy of the raw field octets.
func (v FieldValue) Bytes() []byte {
	return append([]byte(nil), v.Raw...)
}

// Uint64 returns the field as an unsigned integer when it is an integer field.
func (v FieldValue) Uint64() (uint64, bool) {
	u, ok := v.Value.(uint64)
	return u, ok
}

// Record is one decoded data record.
type Record struct {
	Fields []FieldValue
}

// Get returns the first value with the requested field type.
func (r Record) Get(fieldType uint16) (any, bool) {
	for i := range r.Fields {
		if r.Fields[i].Field.Type == fieldType && r.Fields[i].Field.Enterprise == 0 {
			return r.Fields[i].Value, true
		}
	}
	return nil, false
}

// GetEnterprise returns the first enterprise field with the requested type and
// enterprise number.
func (r Record) GetEnterprise(fieldType uint16, enterprise uint32) (any, bool) {
	for i := range r.Fields {
		if r.Fields[i].Field.Type == fieldType && r.Fields[i].Field.Enterprise == enterprise {
			return r.Fields[i].Value, true
		}
	}
	return nil, false
}

// Raw returns a copy of the first raw field with the requested field type.
func (r Record) Raw(fieldType uint16) ([]byte, bool) {
	for i := range r.Fields {
		if r.Fields[i].Field.Type == fieldType && r.Fields[i].Field.Enterprise == 0 {
			return r.Fields[i].Bytes(), true
		}
	}
	return nil, false
}

// DataSet is one decoded data set. Records are in wire order.
type DataSet struct {
	Exporter          Exporter
	ObservationDomain uint32
	TemplateID        uint16
	Kind              TemplateKind
	Version           uint16

	// Sequence and ExportTime come from the packet header.
	Sequence   uint32
	ExportTime time.Time
	SysUptime  uint32

	// ReceiveGeneration is the store receive generation of the packet.
	// TemplateGeneration and TemplateRevision identify the exact template
	// revision used to decode it.
	ReceiveGeneration  uint64
	TemplateGeneration uint64
	TemplateRevision   uint64
	ReceivedAt         time.Time

	// Delayed is true when the data set had to wait for its template.
	Delayed bool
	// Raw is the data-set payload without the four-octet set header.
	Raw     []byte
	Records []Record
}

// Key returns the dataset's registry key.
func (d DataSet) Key() TemplateKey {
	return TemplateKey{
		Exporter:          d.Exporter,
		ObservationDomain: d.ObservationDomain,
		TemplateID:        d.TemplateID,
	}
}

// IsOptions reports whether the dataset was decoded with an options template.
func (d DataSet) IsOptions() bool { return d.Kind == TemplateOptions }

// Stats is a snapshot of store counters.
type Stats struct {
	PacketsReceived       uint64
	PacketsMalformed      uint64
	TemplateUpdates       uint64
	OptionTemplateUpdates uint64
	TemplatesExpired      uint64
	TemplatesWithdrawn    uint64
	DataSetsReceived      uint64
	DataSetsDecoded       uint64
	DataSetsQueued        uint64
	DataSetsResolved      uint64
	DataSetsDropped       uint64
	PendingBytesDropped   uint64
	PendingExpired        uint64
	DecodeErrors          uint64
	RecordsDecoded        uint64
	Pending               int
	PendingBytes          int
}

// ParseError describes a malformed packet at a byte offset.
type ParseError struct {
	Offset int
	Reason string
}

func (e *ParseError) Error() string {
	return fmt.Sprintf("dataeng: malformed packet at offset %d: %s", e.Offset, e.Reason)
}

// Unwrap permits errors.Is(err, ErrMalformedPacket).
func (e *ParseError) Unwrap() error { return ErrMalformedPacket }
