package q217

import "fmt"

// VerifyCodeCertificate recomputes the certificate for bytecode and compares every field.
func VerifyCodeCertificate(code []byte, registerCount int, bufferSize int64, certificate *Certificate) error {
	instructions, err := DecodeCode(code)
	if err != nil {
		return err
	}
	return VerifyCertificate(&Program{
		Instructions:  instructions,
		RegisterCount: registerCount,
		BufferSize:    bufferSize,
	}, certificate)
}

// VerifyCertificate recomputes a program certificate and rejects any mismatch.
func VerifyCertificate(program *Program, certificate *Certificate) error {
	if certificate == nil {
		return fmt.Errorf("%w: nil certificate", ErrCertificate)
	}
	recomputed, err := ValidateProgram(program)
	if err != nil {
		return err
	}

	if certificate.RegisterCount != recomputed.RegisterCount ||
		certificate.BufferSize != recomputed.BufferSize ||
		len(certificate.Reads) != len(recomputed.Reads) ||
		len(certificate.Points) != len(recomputed.Points) {
		return fmt.Errorf("%w: certificate metadata mismatch", ErrCertificate)
	}

	for index := range recomputed.Reads {
		expected := recomputed.Reads[index]
		actual := certificate.Reads[index]
		if actual.PC != expected.PC ||
			actual.Width != expected.Width ||
			actual.BufferSize != expected.BufferSize ||
			actual.Offset != expected.Offset ||
			!sameRegisterIntervals(actual.Registers, expected.Registers) {
			return fmt.Errorf("%w: read certificate %d mismatch", ErrCertificate, index)
		}
	}

	for pc := range recomputed.Points {
		expected := recomputed.Points[pc]
		actual := certificate.Points[pc]
		if actual.PC != expected.PC ||
			actual.Reachable != expected.Reachable ||
			!sameRegisterIntervals(actual.Registers, expected.Registers) {
			return fmt.Errorf("%w: program point %d mismatch", ErrCertificate, pc)
		}
	}
	return nil
}

func sameRegisterIntervals(actual, expected []RegisterInterval) bool {
	if len(actual) != len(expected) {
		return false
	}
	for register := range expected {
		if actual[register] != expected[register] {
			return false
		}
	}
	return true
}
