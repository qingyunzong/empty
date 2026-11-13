package dataeng

import (
	"bytes"
	"encoding/binary"
	"errors"
	"net/netip"
	"testing"
	"time"
)

func TestTemplateRefreshOnlyAffectsSubsequentPackets(t *testing.T) {
	store := NewStore()
	exporter := "192.0.2.10"
	domain := uint32(7)

	firstTemplate := v9Packet(domain, 1,
		v9TemplateSet(v9Template(256, v9Field(8, 4))),
	)
	if _, err := store.Receive(exporter, firstTemplate); err != nil {
		t.Fatalf("install first template: %v", err)
	}

	firstData := v9Packet(domain, 2, v9DataSet(256, []byte{192, 0, 2, 1}))
	got, err := store.Receive(exporter, firstData)
	if err != nil {
		t.Fatalf("decode first data: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d data sets, want 1", len(got))
	}
	if field, ok := got[0].Records[0].Get(8); !ok || field != netip.MustParseAddr("192.0.2.1") {
		t.Fatalf("source address = %#v, want 192.0.2.1", field)
	}

	// The refresh and a data set are in the same packet. That data set must
	// still use the template that was active before the packet.
	refreshAndData := v9Packet(domain, 3,
		v9TemplateSet(v9Template(256, v9Field(12, 4))),
		v9DataSet(256, []byte{198, 51, 100, 9}),
	)
	got, err = store.Receive(exporter, refreshAndData)
	if err != nil {
		t.Fatalf("refresh and data: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d data sets after refresh, want 1", len(got))
	}
	if field, ok := got[0].Records[0].Get(8); !ok || field != netip.MustParseAddr("198.51.100.9") {
		t.Fatalf("data decoded with refreshed template: %#v", got[0].Records[0].Fields)
	}

	nextData := v9Packet(domain, 4, v9DataSet(256, []byte{203, 0, 113, 5}))
	got, err = store.Receive(exporter, nextData)
	if err != nil {
		t.Fatalf("decode after refresh: %v", err)
	}
	if field, ok := got[0].Records[0].Get(12); !ok || field != netip.MustParseAddr("203.0.113.5") {
		t.Fatalf("destination address = %#v", field)
	}
	if _, ok := got[0].Records[0].Get(8); ok {
		t.Fatal("old source-address field is still present")
	}
}

func TestTemplateAndDataInSamePacketAreNotCombined(t *testing.T) {
	store := NewStore()
	packet := v9Packet(9, 1,
		v9TemplateSet(v9Template(256, v9Field(8, 4))),
		v9DataSet(256, []byte{192, 0, 2, 1}),
	)
	got, err := store.Receive("192.0.2.20", packet)
	if err != nil {
		t.Fatalf("receive: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("got %d data sets, want none", len(got))
	}
	if store.Pending() != 1 {
		t.Fatalf("pending = %d, want 1", store.Pending())
	}

	// A later packet may refresh the template; only now can the queued data be
	// decoded.
	got, err = store.Receive("192.0.2.20", v9Packet(9, 2,
		v9TemplateSet(v9Template(256, v9Field(8, 4))),
	))
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if len(got) != 1 || !got[0].Delayed {
		t.Fatalf("resolved data = %#v", got)
	}
	if store.Pending() != 0 {
		t.Fatalf("pending = %d, want 0", store.Pending())
	}
}

func TestPendingIsBoundedAndDeliveredInReceiveOrder(t *testing.T) {
	store := NewStore(Config{MaxPending: 2})
	const exporter = "192.0.2.30"

	for i, value := range []byte{1, 2, 3} {
		payload := []byte{0, 0, 0, value}
		_, err := store.Receive(exporter, v9Packet(5, uint32(i+1), v9DataSet(256, payload)))
		if err != nil {
			t.Fatalf("queue %d: %v", i, err)
		}
	}
	stats := store.Stats()
	if stats.Pending != 2 {
		t.Fatalf("pending = %d, want 2", stats.Pending)
	}
	if stats.DataSetsDropped != 1 {
		t.Fatalf("dropped = %d, want 1", stats.DataSetsDropped)
	}

	got, err := store.Receive(exporter, v9Packet(5, 4,
		v9TemplateSet(v9Template(256, v9Field(1, 4))),
	))
	if err != nil {
		t.Fatalf("install template: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("resolved %d data sets, want 2", len(got))
	}
	for i, want := range []uint64{1, 2} {
		value, ok := got[i].Records[0].Get(1)
		if !ok || value != want {
			t.Fatalf("resolved[%d] = %#v, want %d", i, value, want)
		}
		if got[i].ReceiveGeneration >= got[i].TemplateGeneration {
			t.Fatalf("template generation %d is not later than data generation %d",
				got[i].TemplateGeneration, got[i].ReceiveGeneration)
		}
	}
}

func TestTemplatesAreScopedByExporterAndObservationDomain(t *testing.T) {
	store := NewStore()
	if _, err := store.Receive("192.0.2.31", v9Packet(1, 1,
		v9TemplateSet(v9Template(256, v9Field(8, 4))),
	)); err != nil {
		t.Fatal(err)
	}

	// Same domain, different exporter: no template.
	got, err := store.Receive("192.0.2.32", v9Packet(1, 2, v9DataSet(256, []byte{192, 0, 2, 1})))
	if err != nil || len(got) != 0 {
		t.Fatalf("other exporter: got %d, err %v", len(got), err)
	}
	// Same exporter, different observation domain: no template.
	got, err = store.Receive("192.0.2.31", v9Packet(2, 3, v9DataSet(256, []byte{192, 0, 2, 2})))
	if err != nil || len(got) != 0 {
		t.Fatalf("other domain: got %d, err %v", len(got), err)
	}
	// The original key still works.
	got, err = store.Receive("192.0.2.31", v9Packet(1, 4, v9DataSet(256, []byte{192, 0, 2, 3})))
	if err != nil || len(got) != 1 {
		t.Fatalf("original scope: got %d, err %v", len(got), err)
	}
	if store.Pending() != 2 {
		t.Fatalf("pending = %d, want 2 unrelated keys", store.Pending())
	}
}

func TestPendingByteBound(t *testing.T) {
	store := NewStore(Config{MaxPending: -1, MaxPendingBytes: 4})
	const exporter = "192.0.2.33"
	for i := 0; i < 2; i++ {
		if _, err := store.Receive(exporter, v9Packet(1, uint32(i+1),
			v9DataSet(256, []byte{0, 0, 0, byte(i + 1)}),
		)); err != nil {
			t.Fatal(err)
		}
	}
	stats := store.Stats()
	if stats.Pending != 1 || stats.PendingBytes != 4 {
		t.Fatalf("pending = %d/%d, want 1/4", stats.Pending, stats.PendingBytes)
	}
	if stats.PendingBytesDropped != 4 {
		t.Fatalf("byte-dropped = %d, want 4", stats.PendingBytesDropped)
	}
}

func TestExpiredTemplateNeverGuessesFields(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	clock := func() time.Time { return now }
	store := NewStore(Config{
		TemplateTTL: time.Minute,
		PendingTTL:  10 * time.Minute,
		Clock:       clock,
		MaxPending:  4,
	})
	const exporter = "192.0.2.40"

	if _, err := store.Receive(exporter, v9Packet(1, 1,
		v9TemplateSet(v9Template(256, v9Field(8, 4))),
	)); err != nil {
		t.Fatal(err)
	}
	now = now.Add(30 * time.Second)
	got, err := store.Receive(exporter, v9Packet(1, 2, v9DataSet(256, []byte{192, 0, 2, 1})))
	if err != nil || len(got) != 1 {
		t.Fatalf("live template: got %d, err %v", len(got), err)
	}

	now = now.Add(2 * time.Minute)
	got, err = store.Receive(exporter, v9Packet(1, 3, v9DataSet(256, []byte{192, 0, 2, 2})))
	if err != nil {
		t.Fatalf("expired template receive: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expired template decoded %d data sets", len(got))
	}
	if store.Pending() != 1 {
		t.Fatalf("pending = %d, want 1", store.Pending())
	}
	if _, ok := store.LookupTemplate(exporter, 1, 256); ok {
		t.Fatal("expired template is still visible")
	}
}

func TestOptionsTemplateIsManagedIndependently(t *testing.T) {
	store := NewStore()
	const exporter = "192.0.2.50"

	// Same template ID in both namespaces: installing options must not
	// replace the data template.
	if _, err := store.RegisterTemplate(exporter, 1, Template{
		TemplateID: 300,
		Kind:       TemplateData,
		Fields:     []Field{{Type: 8, Length: 4}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.RegisterTemplate(exporter, 1, Template{
		ID:              300,
		Kind:            TemplateOptions,
		Fields:          []Field{{Type: 1, Length: 4}, {Type: 82, Length: 4}},
		ScopeFieldCount: 1,
	}); err != nil {
		t.Fatal(err)
	}

	dataTmpl, ok := store.DataTemplate(exporter, 1, 300)
	if !ok || dataTmpl.Kind != TemplateData {
		t.Fatalf("data template = %#v, %v", dataTmpl, ok)
	}
	optionTmpl, ok := store.OptionTemplate(exporter, 1, 300)
	if !ok || optionTmpl.Kind != TemplateOptions {
		t.Fatalf("option template = %#v, %v", optionTmpl, ok)
	}

	records, err := store.DecodeDataSet(exporter, 1, 300, []byte{192, 0, 2, 99})
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := records[0].Get(8); got != netip.MustParseAddr("192.0.2.99") {
		t.Fatalf("data decode field = %#v", got)
	}

	records, err = store.DecodeOptionDataSet(exporter, 1, 300, []byte{0, 0, 0, 7, 'e', 't', 'h', '0'})
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := records[0].Get(1); got != uint64(7) {
		t.Fatalf("option scope = %#v", got)
	}
	if got, _ := records[0].Get(82); got != "eth0" {
		t.Fatalf("option value = %#v", got)
	}
}

func TestV9OptionsTemplateOnTheWire(t *testing.T) {
	store := NewStore()
	const exporter = "192.0.2.55"

	optionRecord := v9OptionsTemplate(300, 4, 4,
		v9Field(1, 4),  // scope: octetDeltaCount
		v9Field(82, 4), // option: interfaceName
	)
	if _, err := store.Receive(exporter, v9Packet(2, 1, flowSet(netflowV9OptionsTemplateSet, optionRecord))); err != nil {
		t.Fatalf("install v9 options template: %v", err)
	}
	tmpl, ok := store.OptionTemplate(exporter, 2, 300)
	if !ok || tmpl.Kind != TemplateOptions || tmpl.ScopeFieldCount != 1 {
		t.Fatalf("options template = %#v, %v", tmpl, ok)
	}
	if _, ok := store.DataTemplate(exporter, 2, 300); ok {
		t.Fatal("options template leaked into the data registry")
	}

	got, err := store.Receive(exporter, v9Packet(2, 2, v9DataSet(300,
		[]byte{0, 0, 0, 9, 'e', 't', 'h', '0'},
	)))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || !got[0].IsOptions() {
		t.Fatalf("options data = %#v", got)
	}
	if value, _ := got[0].Records[0].Get(1); value != uint64(9) {
		t.Fatalf("scope value = %#v", value)
	}
	if value, _ := got[0].Records[0].Get(82); value != "eth0" {
		t.Fatalf("option value = %#v", value)
	}
}

func TestTemplateAndOptionTTLExpireIndependently(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	store := NewStore(Config{
		TemplateTTL:       time.Minute,
		OptionTemplateTTL: 2 * time.Minute,
		Clock:             func() time.Time { return now },
	})
	const exporter = "192.0.2.56"
	if _, err := store.RegisterTemplate(exporter, 1, Template{
		ID:     301,
		Kind:   TemplateData,
		Fields: []Field{{Type: 8, Length: 4}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.RegisterTemplate(exporter, 1, Template{
		ID:              302,
		Kind:            TemplateOptions,
		Fields:          []Field{{Type: 1, Length: 4}},
		ScopeFieldCount: 1,
	}); err != nil {
		t.Fatal(err)
	}

	now = now.Add(90 * time.Second)
	if _, ok := store.DataTemplate(exporter, 1, 301); ok {
		t.Fatal("data template did not expire")
	}
	if _, ok := store.OptionTemplate(exporter, 1, 302); !ok {
		t.Fatal("options template expired too early")
	}
}

func TestIPFIXVariableLengthEnterpriseAndWithdrawal(t *testing.T) {
	store := NewStore()
	const exporter = "2001:db8::1"
	const domain = 42

	template := makeIPFIXTemplateSet(false,
		ipfixTemplate(400, false,
			ipfixField(8, 4, 0),
			ipfixField(1000, variableLengthField, 4242),
		),
	)
	packet := ipfixPacket(domain, 1, template)
	if _, err := store.Receive(exporter, packet); err != nil {
		t.Fatalf("install IPFIX template: %v", err)
	}

	// Variable-length encoding: one-octet length followed by the value.
	payload := append([]byte{192, 0, 2, 77, 3}, []byte("abc")...)
	got, err := store.Receive(exporter, ipfixPacket(domain, 2, ipfixDataSet(400, payload)))
	if err != nil {
		t.Fatalf("IPFIX data: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d data sets, want 1", len(got))
	}
	if value, _ := got[0].Records[0].Get(8); value != netip.MustParseAddr("192.0.2.77") {
		t.Fatalf("address = %#v", value)
	}
	if value, _ := got[0].Records[0].GetEnterprise(1000, 4242); !bytes.Equal(value.([]byte), []byte("abc")) {
		t.Fatalf("enterprise variable field = %#v", value)
	}

	// A zero-count template record is a withdrawal. The data set after it must
	// be queued rather than decoded with the withdrawn template.
	if _, err := store.Receive(exporter, ipfixPacket(domain, 3, makeIPFIXTemplateSet(false, ipfixTemplate(400, false)))); err != nil {
		t.Fatalf("withdraw: %v", err)
	}
	got, err = store.Receive(exporter, ipfixPacket(domain, 4, ipfixDataSet(400, []byte{192, 0, 2, 77})))
	if err != nil {
		t.Fatalf("after withdrawal: %v", err)
	}
	if len(got) != 0 || store.Pending() != 1 {
		t.Fatalf("withdrawn template was used: got %d, pending %d", len(got), store.Pending())
	}
}

func TestMalformedPacketDoesNotChangeState(t *testing.T) {
	store := NewStore()
	bad := make([]byte, 20)
	binary.BigEndian.PutUint16(bad, 9)
	binary.BigEndian.PutUint16(bad[2:], 1)
	binary.BigEndian.PutUint32(bad[16:], 1)
	// A flowset that claims to be longer than the packet.
	bad = append(bad, 0, 1, 0, 32)

	_, err := store.Receive("192.0.2.60", bad)
	if !errors.Is(err, ErrMalformedPacket) {
		t.Fatalf("error = %v, want ErrMalformedPacket", err)
	}
	if store.Generation() != 0 {
		t.Fatalf("generation changed to %d", store.Generation())
	}
}

func TestTrailingPaddingIsTolerated(t *testing.T) {
	store := NewStore()
	if _, err := store.RegisterTemplate("192.0.2.70", 1, Template{
		ID:     256,
		Fields: []Field{{Type: 1, Length: 4}},
	}); err != nil {
		t.Fatal(err)
	}
	records, err := store.DecodeDataSet("192.0.2.70", 1, 256, []byte{0, 0, 0, 1, 0, 0})
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 {
		t.Fatalf("records = %d, want 1", len(records))
	}
}

func v9Field(fieldType, length uint16) Field {
	return Field{Type: fieldType, Length: length}
}

func v9Template(id uint16, fields ...Field) []byte {
	var b bytes.Buffer
	_ = binary.Write(&b, binary.BigEndian, id)
	_ = binary.Write(&b, binary.BigEndian, uint16(len(fields)))
	for _, field := range fields {
		_ = binary.Write(&b, binary.BigEndian, field.Type)
		_ = binary.Write(&b, binary.BigEndian, field.Length)
	}
	return b.Bytes()
}

func v9TemplateSet(records ...[]byte) []byte {
	return flowSet(0, records...)
}

func v9DataSet(id uint16, payload []byte) []byte {
	return flowSet(id, payload)
}

func v9OptionsTemplate(id uint16, scopeBytes, optionBytes uint16, fields ...Field) []byte {
	var b bytes.Buffer
	_ = binary.Write(&b, binary.BigEndian, id)
	_ = binary.Write(&b, binary.BigEndian, scopeBytes)
	_ = binary.Write(&b, binary.BigEndian, optionBytes)
	for _, field := range fields {
		_ = binary.Write(&b, binary.BigEndian, field.Type)
		_ = binary.Write(&b, binary.BigEndian, field.Length)
	}
	return b.Bytes()
}

func flowSet(id uint16, parts ...[]byte) []byte {
	body := bytes.Join(parts, nil)
	var b bytes.Buffer
	_ = binary.Write(&b, binary.BigEndian, id)
	_ = binary.Write(&b, binary.BigEndian, uint16(4+len(body)))
	_, _ = b.Write(body)
	return b.Bytes()
}

func v9Packet(domain, sequence uint32, sets ...[]byte) []byte {
	var b bytes.Buffer
	_ = binary.Write(&b, binary.BigEndian, uint16(9))
	_ = binary.Write(&b, binary.BigEndian, uint16(0))
	_ = binary.Write(&b, binary.BigEndian, uint32(1000))
	_ = binary.Write(&b, binary.BigEndian, uint32(1_700_000_000))
	_ = binary.Write(&b, binary.BigEndian, sequence)
	_ = binary.Write(&b, binary.BigEndian, domain)
	for _, set := range sets {
		_, _ = b.Write(set)
	}
	return b.Bytes()
}

func ipfixField(fieldType, length uint16, enterprise uint32) []byte {
	var b bytes.Buffer
	t := fieldType
	if enterprise != 0 {
		t |= enterpriseBit
	}
	_ = binary.Write(&b, binary.BigEndian, t)
	_ = binary.Write(&b, binary.BigEndian, length)
	if enterprise != 0 {
		_ = binary.Write(&b, binary.BigEndian, enterprise)
	}
	return b.Bytes()
}

func ipfixTemplate(id uint16, options bool, fields ...[]byte) []byte {
	var b bytes.Buffer
	_ = binary.Write(&b, binary.BigEndian, id)
	_ = binary.Write(&b, binary.BigEndian, uint16(len(fields)))
	if options {
		_ = binary.Write(&b, binary.BigEndian, uint16(0))
	}
	for _, field := range fields {
		_, _ = b.Write(field)
	}
	return b.Bytes()
}

func makeIPFIXTemplateSet(options bool, records ...[]byte) []byte {
	id := uint16(ipfixTemplateSet)
	if options {
		id = ipfixOptionsTemplateSet
	}
	return flowSet(id, records...)
}

func ipfixDataSet(id uint16, payload []byte) []byte {
	return flowSet(id, payload)
}

func ipfixPacket(domain, sequence uint32, sets ...[]byte) []byte {
	var body bytes.Buffer
	for _, set := range sets {
		_, _ = body.Write(set)
	}
	var b bytes.Buffer
	_ = binary.Write(&b, binary.BigEndian, uint16(10))
	_ = binary.Write(&b, binary.BigEndian, uint16(16+body.Len()))
	_ = binary.Write(&b, binary.BigEndian, uint32(1_700_000_000))
	_ = binary.Write(&b, binary.BigEndian, sequence)
	_ = binary.Write(&b, binary.BigEndian, domain)
	_, _ = b.Write(body.Bytes())
	return b.Bytes()
}
