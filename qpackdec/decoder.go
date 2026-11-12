package qpackdec

import "errors"

// streamStatus tracks one stream id for its whole component lifetime so that
// delivered and cancelled ids can never be reused.
type streamStatus int

const (
	statusBlocked   streamStatus = iota // waiting on a future insert count
	statusDelivered                     // header block already handed to the host
	statusCancelled                     // stream was cancelled; must never deliver
)

// blockedBlock is a header block frozen at reception. Every recovered value is
// stored explicitly so a later insert count can never re-interpret E.
type blockedBlock struct {
	block    HeaderBlock
	required int64 // recovered required insert count R
	base     int64 // recovered base
}

// Decoder is the importable QPACK receiver component.
type Decoder struct {
	table      *dynamicTable
	static     []StaticField
	blockedMax int64
	blocked    []blockedBlock
	status     map[int64]streamStatus
	outbox     []Delivery
	dead       *DecodeError
}

// New builds a receiver. maxCapacity M and blockedLimit are non-negative. The
// static table starts at index zero and is retained verbatim. The dynamic
// table starts with capacity zero.
func New(maxCapacity int64, blockedLimit int64, static []StaticField) (*Decoder, error) {
	if maxCapacity < 0 {
		return nil, errors.New("max table capacity must be non-negative")
	}
	if blockedLimit < 0 {
		return nil, errors.New("blocked stream limit must be non-negative")
	}
	copied := make([]StaticField, len(static))
	copy(copied, static)
	return &Decoder{
		table:      newDynamicTable(maxCapacity),
		static:     copied,
		blockedMax: blockedLimit,
		status:     make(map[int64]streamStatus),
	}, nil
}

// Err returns the terminal decode error together with its evidence, or nil.
func (d *Decoder) Err() *DecodeError { return d.dead }

// InsertCount returns the exact total number of dynamic insertions so far.
func (d *Decoder) InsertCount() int64 { return d.table.insertCount() }

// CurrentCapacity returns the current dynamic-table capacity.
func (d *Decoder) CurrentCapacity() int64 { return d.table.capacity }

// MaxCapacity returns the configured M.
func (d *Decoder) MaxCapacity() int64 { return d.table.maxCapacity }

// BlockedStreams returns the number of streams currently waiting.
func (d *Decoder) BlockedStreams() int { return len(d.blocked) }

// fail records the first terminal error and stops the component. It returns
// the stored error so callers can return it directly.
func (d *Decoder) fail(code, op string, streamID int64, hb *HeaderBlock, detail string) *DecodeError {
	if d.dead != nil {
		return d.dead
	}
	var hbCopy *HeaderBlock
	if hb != nil {
		c := *hb
		hbCopy = &c
	}
	d.dead = &DecodeError{
		Code: code,
		Evidence: ErrorEvidence{
			Op:          op,
			StreamID:    streamID,
			InsertCount: d.table.insertCount(),
			Header:      hbCopy,
			Detail:      detail,
		},
	}
	d.blocked = nil
	return d.dead
}

// Insert applies one dynamic-table insertion. Newly unblocked header blocks
// that are now deliverable are returned in reception order. A terminal error
// leaves the decoder stopped.
func (d *Decoder) Insert(name, value string) ([]Delivery, error) {
	if d.dead != nil {
		return nil, d.dead
	}
	if _, _, err := d.table.insert(name, value); err != nil {
		return nil, d.fail("dynamic_table_insertion_failed", "insert", -1, nil, err.Error())
	}
	// insert has already committed nextAbs before pump observes the table, so
	// a blocked block referencing the freshly assigned absolute index resolves.
	delivered := d.pump()
	if d.dead != nil {
		return nil, d.dead
	}
	return delivered, nil
}

// SetCapacity adjusts the current dynamic-table capacity to capacity, evicting
// oldest entries as required. Capacity must be in [0, M].
func (d *Decoder) SetCapacity(capacity int64) error {
	if d.dead != nil {
		return d.dead
	}
	if err := d.table.setCapacity(capacity); err != nil {
		return d.fail("capacity_update_failed", "set_capacity", -1, nil, err.Error())
	}
	return nil
}

// CancelStream cancels a blocked stream. Its header block is discarded and can
// never be delivered; the stream id remains reserved and cannot be reused.
func (d *Decoder) CancelStream(streamID int64) error {
	if d.dead != nil {
		return d.dead
	}
	if streamID < 0 {
		return d.fail("invalid_stream_id", "cancel_stream", streamID, nil, "stream id must be non-negative")
	}
	switch d.status[streamID] {
	case statusDelivered:
		return d.fail("stream_id_reuse", "cancel_stream", streamID, nil, "stream already delivered")
	case statusCancelled:
		return d.fail("stream_id_reuse", "cancel_stream", streamID, nil, "stream already cancelled")
	}
	for i := range d.blocked {
		if d.blocked[i].block.StreamID == streamID {
			d.blocked = append(d.blocked[:i], d.blocked[i+1:]...)
			break
		}
	}
	d.status[streamID] = statusCancelled
	return nil
}

// Drain returns and clears any deliveries buffered inside the component.
// Mutating operations return new deliveries directly, but Drain lets a host
// that ignored the return value retrieve them.
func (d *Decoder) Drain() []Delivery {
	out := d.outbox
	d.outbox = nil
	return out
}

// HeaderBlockReceived handles one header block. If every reference is already
// available it is delivered immediately; otherwise a frozen copy is stored and
// delivered later in reception order.
func (d *Decoder) HeaderBlockReceived(hb HeaderBlock) ([]Delivery, error) {
	if d.dead != nil {
		return nil, d.dead
	}
	if hb.StreamID < 0 {
		return nil, d.fail("invalid_stream_id", "header_block", hb.StreamID, &hb, "stream id must be non-negative")
	}
	if hb.EncodedCount < 0 {
		return nil, d.fail("invalid_encoded_insert_count", "header_block", hb.StreamID, &hb, "encoded count must be non-negative")
	}
	if hb.Delta < 0 {
		return nil, d.fail("invalid_delta", "header_block", hb.StreamID, &hb, "delta must be non-negative")
	}
	if hb.Sign != 0 && hb.Sign != 1 {
		return nil, d.fail("invalid_base_sign", "header_block", hb.StreamID, &hb, "sign must be 0 or 1")
	}
	if prior, ok := d.status[hb.StreamID]; ok {
		detail := "duplicate stream id"
		if prior == statusCancelled {
			detail = "cancelled stream id cannot be reused"
		} else if prior == statusDelivered {
			detail = "delivered stream id cannot be reused"
		}
		return nil, d.fail("stream_id_reuse", "header_block", hb.StreamID, &hb, detail)
	}

	insertCount := d.table.insertCount()
	required, err := requiredInsertCount(hb.EncodedCount, insertCount, d.table.maxCapacity)
	if err != nil {
		return nil, d.fail("invalid_encoded_insert_count", "header_block", hb.StreamID, &hb, err.Error())
	}
	base, err := computeBase(required, hb.Sign, hb.Delta)
	if err != nil {
		return nil, d.fail("invalid_base", "header_block", hb.StreamID, &hb, err.Error())
	}

	if required > insertCount {
		if int64(len(d.blocked)) >= d.blockedMax {
			return nil, d.fail("blocked_stream_limit_exceeded", "header_block", hb.StreamID, &hb,
				"blocking this stream would exceed the blocked stream limit")
		}
		d.blocked = append(d.blocked, blockedBlock{
			block:    hb,
			required: required,
			base:     base,
		})
		d.status[hb.StreamID] = statusBlocked
		return nil, nil
	}

	header, derr := d.resolve(hb, base, required)
	if derr != nil {
		return nil, derr
	}
	d.status[hb.StreamID] = statusDelivered
	delivery := Delivery{StreamID: hb.StreamID, Header: header}
	d.outbox = append(d.outbox, delivery)
	return []Delivery{delivery}, nil
}

// pump releases blocked blocks whose required insert count is now reachable.
// Blocks remain in reception order, so deliveries are emitted in that order;
// still-waiting blocks keep their relative queue position for a later pump.
func (d *Decoder) pump() []Delivery {
	if len(d.blocked) == 0 {
		return nil
	}
	current := d.table.insertCount()
	var delivered []Delivery
	keep := d.blocked[:0]
	for _, bb := range d.blocked {
		if bb.required > current {
			keep = append(keep, bb)
			continue
		}
		// R is reachable, but an entry it references may have been evicted
		// while the block waited. That is a permanent connection error: the
		// absolute index must never be re-bound to a newer ring-slot entry.
		if derr := d.checkDynamicLiveness(bb); derr != nil {
			d.dead = derr
			return nil
		}
		header, derr := d.resolve(bb.block, bb.base, bb.required)
		if derr != nil {
			d.dead = derr
			return nil
		}
		d.status[bb.block.StreamID] = statusDelivered
		delivery := Delivery{StreamID: bb.block.StreamID, Header: header}
		delivered = append(delivered, delivery)
		d.outbox = append(d.outbox, delivery)
	}
	d.blocked = keep
	return delivered
}

// checkDynamicLiveness verifies that every dynamic reference of a now-ready
// blocked block still points at a live table entry. It only inspects liveness;
// full validation stays in resolve.
func (d *Decoder) checkDynamicLiveness(bb blockedBlock) *DecodeError {
	for _, f := range bb.block.Fields {
		if f.Kind != FieldRelative && f.Kind != FieldPostBase {
			continue
		}
		abs, err := dynamicAbsolute(bb.base, f)
		if err != nil {
			return d.fail("invalid_dynamic_reference", "pump", bb.block.StreamID, &bb.block, err.Error())
		}
		if abs < 0 {
			return d.fail("invalid_dynamic_reference", "pump", bb.block.StreamID, &bb.block,
				"negative absolute dynamic index")
		}
		if _, ok := d.table.lookup(abs); !ok {
			return d.fail("evicted_dynamic_reference", "pump", bb.block.StreamID, &bb.block,
				"dynamic entry evicted while header block waited")
		}
	}
	return nil
}

// resolve fully validates one header block against the table snapshot. It is
// only called once R is reachable, so an evicted absolute reference is a hard
// error rather than re-reading a newer entry at the same ring slot.
func (d *Decoder) resolve(hb HeaderBlock, base, required int64) (*ResolvedHeader, *DecodeError) {
	out := &ResolvedHeader{StreamID: hb.StreamID, Fields: make([]ResolvedField, 0, len(hb.Fields))}
	var maxDynamic int64 = -1
	sawDynamic := false

	for _, f := range hb.Fields {
		switch f.Kind {
		case FieldLiteral:
			out.Fields = append(out.Fields, ResolvedField{
				Name:         f.Name,
				Value:        f.Value,
				Source:       SourceLiteral,
				StaticIndex:  -1,
				DynamicIndex: -1,
			})
		case FieldStatic:
			if f.Index < 0 || f.Index >= int64(len(d.static)) {
				return nil, d.fail("invalid_static_index", "resolve", hb.StreamID, &hb,
					"static index out of range")
			}
			sf := d.static[f.Index]
			out.Fields = append(out.Fields, ResolvedField{
				Name:         sf.Name,
				Value:        sf.Value,
				Source:       SourceStatic,
				StaticIndex:  f.Index,
				DynamicIndex: -1,
			})
		case FieldRelative, FieldPostBase:
			abs, err := dynamicAbsolute(base, f)
			if err != nil {
				return nil, d.fail("invalid_dynamic_reference", "resolve", hb.StreamID, &hb, err.Error())
			}
			if abs < 0 {
				return nil, d.fail("invalid_dynamic_reference", "resolve", hb.StreamID, &hb,
					"negative absolute dynamic index")
			}
			tableEntry, ok := d.table.lookup(abs)
			if !ok {
				return nil, d.fail("evicted_dynamic_reference", "resolve", hb.StreamID, &hb,
					"dynamic entry has been evicted; a newer entry at the same slot is not used")
			}
			out.Fields = append(out.Fields, ResolvedField{
				Name:         tableEntry.name,
				Value:        tableEntry.value,
				Source:       SourceDynamic,
				StaticIndex:  -1,
				DynamicIndex: tableEntry.abs,
			})
			sawDynamic = true
			if abs > maxDynamic {
				maxDynamic = abs
			}
		default:
			return nil, d.fail("invalid_field_kind", "resolve", hb.StreamID, &hb, "unknown field kind")
		}
	}

	if sawDynamic {
		if maxDynamic+1 != required {
			return nil, d.fail("inconsistent_required_insert_count", "resolve", hb.StreamID, &hb,
				"max dynamic absolute index plus one must equal required insert count")
		}
	} else if required != 0 {
		return nil, d.fail("inconsistent_required_insert_count", "resolve", hb.StreamID, &hb,
			"header block without dynamic references must require insert count zero")
	}
	return out, nil
}
