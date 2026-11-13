package dataeng_test

import (
	"bytes"
	"errors"
	"fmt"
	"testing"
	"time"

	"example.org/dataeng13/q0034"
)

// refSixBit decodes NMEA six-bit ASCII armor independently of the package.
func refSixBit(c byte) ([]byte, bool) {
	var value byte
	switch {
	case c >= 48 && c <= 87:
		value = c - 48
	case c >= 96 && c <= 119:
		value = c - 56
	default:
		return nil, false
	}
	return refValueBits(value), true
}

func refNMEALine(body string) string {
	var checksum byte
	for i := 0; i < len(body); i++ {
		checksum ^= body[i]
	}
	return fmt.Sprintf("!%s*%02X", body, checksum)
}

func TestParseAndAddSingleNMEASentence(t *testing.T) {
	line := refNMEALine("AIVDM,1,1,7,A,0,0")
	sentence, err := dataeng.ParseNMEA(line)
	if err != nil {
		t.Fatalf("ParseNMEA: %v", err)
	}
	expected, ok := refSixBit('0')
	if !ok {
		t.Fatal("test reference rejected payload character")
	}
	if sentence.MessageID != "7" || sentence.Total != 1 || sentence.Number != 1 || sentence.FillBits != 0 {
		t.Fatalf("parsed fields = %+v", sentence)
	}
	if !bytes.Equal(sentence.Bits, expected) {
		t.Fatalf("parsed bits = %v, want %v", sentence.Bits, expected)
	}

	assembler := dataeng.NewAssembler(time.Minute)
	result := assembler.AddLine(line, time.Unix(300, 0))
	if result.Status != dataeng.StatusComplete {
		t.Fatalf("AddLine status = %v, err = %v", result.Status, result.Err)
	}
	if !bytes.Equal(result.Message.Bits, expected) {
		t.Fatalf("message bits = %v, want %v", result.Message.Bits, expected)
	}
}

func TestNMEAOutOfOrderAndIgnoreRadioChannel(t *testing.T) {
	firstBody := "AIVDM,2,1,3,A,0,0"
	secondBody := "AIVDM,2,2,3,B,W,0"
	firstLine := refNMEALine(firstBody)
	secondLine := refNMEALine(secondBody)

	firstBits, ok := refSixBit('0')
	if !ok {
		t.Fatal("test reference rejected first payload character")
	}
	secondBits, ok := refSixBit('W')
	if !ok {
		t.Fatal("test reference rejected second payload character")
	}
	expected := refConcat(firstBits, secondBits)

	assembler := dataeng.NewAssembler(time.Minute)
	result := assembler.AddLine(secondLine, time.Unix(310, 0))
	if result.Status != dataeng.StatusAccepted {
		t.Fatalf("second sentence status = %v, err = %v", result.Status, result.Err)
	}
	result = assembler.AddLine(firstLine, time.Unix(310, 0))
	if result.Status != dataeng.StatusComplete {
		t.Fatalf("first sentence status = %v, err = %v", result.Status, result.Err)
	}
	if result.MessageID != "3" || !bytes.Equal(result.Message.Bits, expected) {
		t.Fatalf("message = %+v, want id 3 bits %v", result.Message, expected)
	}
}

func TestNMEAChecksumFailureMarksMessageFailed(t *testing.T) {
	body := "AIVDM,1,1,9,A,0,0"
	var checksum byte
	for i := 0; i < len(body); i++ {
		checksum ^= body[i]
	}
	badLine := fmt.Sprintf("!%s*%02X", body, checksum^0xff)

	sentence, err := dataeng.ParseNMEA(badLine)
	if !errors.Is(err, dataeng.ErrChecksum) {
		t.Fatalf("ParseNMEA error = %v, want ErrChecksum", err)
	}
	if sentence.MessageID != "9" || len(sentence.Bits) != 6 {
		t.Fatalf("checksum failure should still expose parsed identity, got %+v", sentence)
	}

	assembler := dataeng.NewAssembler(time.Minute)
	result := assembler.AddLine(badLine, time.Unix(320, 0))
	if result.Status != dataeng.StatusFailed {
		t.Fatalf("AddLine status = %v, want failure", result.Status)
	}
	if !errors.Is(result.Err, dataeng.ErrChecksum) {
		t.Fatalf("error = %v, want wrapped ErrChecksum", result.Err)
	}
	if len(assembler.Pending()) != 0 {
		t.Fatalf("checksum-failed sentence left pending state")
	}
}

func TestNMEAMalformedPayloadAndMissingChecksum(t *testing.T) {
	malformed := "!AIVDM,1,1,4,A,X,0*00"
	sentence, err := dataeng.ParseNMEA(malformed)
	if !errors.Is(err, dataeng.ErrMalformedNMEA) {
		t.Fatalf("ParseNMEA error = %v, want ErrMalformedNMEA", err)
	}
	if sentence.MessageID != "4" || sentence.Total != 1 || sentence.Number != 1 {
		t.Fatalf("partial sentence = %+v", sentence)
	}
	assembler := dataeng.NewAssembler(time.Minute)
	result := assembler.AddLine(malformed, time.Unix(330, 0))
	if result.Status != dataeng.StatusFailed || !errors.Is(result.Err, dataeng.ErrMalformedNMEA) {
		t.Fatalf("malformed result = %+v", result)
	}

	noChecksum := "!AIVDM,1,1,,A,0,0"
	sentence, err = dataeng.ParseNMEA(noChecksum)
	if err != nil {
		t.Fatalf("checksum-less sentence rejected: %v", err)
	}
	if sentence.MessageID != "" {
		t.Fatalf("empty sequence field became %q", sentence.MessageID)
	}
	result = assembler.AddLine(noChecksum, time.Unix(330, 0))
	if result.Status != dataeng.StatusComplete {
		t.Fatalf("checksum-less AddLine status = %v, err = %v", result.Status, result.Err)
	}
}

func TestNMEAFillBitsOnNonFinalSentence(t *testing.T) {
	line := refNMEALine("AIVDM,2,1,6,A,0,1")
	result := dataeng.NewAssembler(time.Minute).AddLine(line, time.Unix(340, 0))
	if result.Status != dataeng.StatusFailed || !errors.Is(result.Err, dataeng.ErrFillBitsNotLast) {
		t.Fatalf("result = %+v, want ErrFillBitsNotLast", result)
	}
}
