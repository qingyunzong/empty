// Command collectorhost is a usage example for the dataeng reader package.
// It builds one FlatBuffers-style device message byte-by-byte, validates it
// against the host's compiled table definitions, and reads fields by path.
package main

import (
	"fmt"
	"os"

	"example.org/dataeng/q0290"
)

func main() {
	// Compiled schema owned by the host. No flatc invocation is involved.
	reading, err := dataeng.NewTable("Reading",
		dataeng.Field{Name: "channel", Kind: dataeng.KindU8, Slot: 0, Default: 1},
		dataeng.Field{Name: "value", Kind: dataeng.KindI64, Slot: 1},
	)
	if err != nil {
		fail(err)
	}
	envelope, err := dataeng.NewTable("Envelope",
		dataeng.Field{Name: "device_id", Kind: dataeng.KindI32, Slot: 0, Default: -1},
		dataeng.Field{Name: "topic", Kind: dataeng.KindString, Slot: 1},
		dataeng.Field{Name: "samples", Kind: dataeng.KindVectorI64, Slot: 2},
		dataeng.Field{Name: "reading", Kind: dataeng.KindTable, Slot: 3, RefTable: reading},
	)
	if err != nil {
		fail(err)
	}

	buf := buildMessage()

	// Open refuses to return a handle until every reachable known object is
	// validated. Shared objects are counted once against the limits.
	handle, err := dataeng.Open(envelope, buf, dataeng.Limits{
		MaxTables:         16,
		MaxVectorElements: 1024,
		MaxStringBytes:    256,
	})
	if err != nil {
		fail(err)
	}

	deviceID, err := handle.Get(dataeng.Step{Field: "device_id"})
	if err != nil {
		fail(err)
	}
	id, _ := deviceID.I32()
	fmt.Printf("device_id=%d defaulted=%t bytes=%d..%d\n",
		id, deviceID.Defaulted, deviceID.Range.Start, deviceID.Range.End)

	topic, err := handle.Get(dataeng.Step{Field: "topic"})
	if err != nil {
		fail(err)
	}
	name, _ := topic.StringValue()
	fmt.Printf("topic=%q field-bytes=%d..%d string-object=%d..%d\n",
		name, topic.Range.Start, topic.Range.End, topic.RefRange.Start, topic.RefRange.End)

	samples, err := handle.Get(dataeng.Step{Field: "samples"})
	if err != nil {
		fail(err)
	}
	values, _ := samples.I64Elements()
	fmt.Printf("samples=%v count-bytes=%d..%d\n", values, samples.RefRange.Start, samples.RefRange.End)

	first, err := handle.Get(
		dataeng.Step{Field: "samples"},
		dataeng.Step{Index: 0},
	)
	if err != nil {
		fail(err)
	}
	firstValue, _ := first.I64()
	fmt.Printf("samples[0]=%d bytes=%d..%d\n", firstValue, first.Range.Start, first.Range.End)

	channel, err := handle.Get(
		dataeng.Step{Field: "reading"},
		dataeng.Step{Field: "channel"},
	)
	if err != nil {
		fail(err)
	}
	ch, _ := channel.U8()
	fmt.Printf("reading.channel=%d defaulted=%t (schema default)\n", ch, channel.Defaulted)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "collectorhost:", err)
	os.Exit(1)
}

// buildMessage lays out the example at fixed absolute positions so the
// construction is independent of any FlatBuffers toolchain.
func buildMessage() []byte {
	const size = 128
	buf := make([]byte, size)
	putU16 := func(pos uint32, v uint16) {
		buf[pos] = byte(v)
		buf[pos+1] = byte(v >> 8)
	}
	putU32 := func(pos uint32, v uint32) {
		buf[pos] = byte(v)
		buf[pos+1] = byte(v >> 8)
		buf[pos+2] = byte(v >> 16)
		buf[pos+3] = byte(v >> 24)
	}
	putI32 := func(pos uint32, v int32) { putU32(pos, uint32(v)) }
	putI64 := func(pos uint32, v int64) {
		u := uint64(v)
		for i := 0; i < 8; i++ {
			buf[pos+uint32(i)] = byte(u >> (8 * i))
		}
	}
	ref := func(fieldPos, target uint32) { putU32(fieldPos, target-fieldPos) }

	const (
		envVT, envTable uint32 = 8, 24
		topicPos        uint32 = 48
		vecPos          uint32 = 68
		readVT, readTab uint32 = 100, 112
	)

	// Root offset.
	putU32(0, envTable-4)

	// Envelope vtable: object 20 bytes, slots id/topic/samples/reading.
	putU16(envVT, 12)
	putU16(envVT+2, 20)
	putU16(envVT+4, 4)
	putU16(envVT+6, 8)
	putU16(envVT+8, 12)
	putU16(envVT+10, 16)
	putI32(envTable, int32(envTable)-int32(envVT))
	putI32(envTable+4, 7)
	ref(envTable+8, topicPos)
	ref(envTable+12, vecPos)
	ref(envTable+16, readTab)

	// Topic string "telemetry" plus NUL.
	topic := "telemetry"
	putU32(topicPos, uint32(len(topic)))
	copy(buf[topicPos+4:], topic)
	buf[topicPos+4+uint32(len(topic))] = 0

	// i64 vector; its element area at vecPos+4 is 8-aligned here.
	putU32(vecPos, 3)
	putI64(vecPos+4, 11)
	putI64(vecPos+12, 22)
	putI64(vecPos+20, 33)

	// Reading table: channel slot omitted (uses schema default), value at 8.
	putU16(readVT, 8)
	putU16(readVT+2, 16)
	putU16(readVT+4, 0)
	putU16(readVT+6, 8)
	putI32(readTab, int32(readTab)-int32(readVT))
	putI64(readTab+8, -42)

	return buf
}
