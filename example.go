package dataeng

// AlignmentExample is a ready-to-run vocabulary alignment scenario. The
// source-side concept Visit is aligned with the target-side Encounter, while
// "has a subject that is a Patient" is deliberately not treated as implying
// that Visit itself is a Patient.
type AlignmentExample struct {
	Snapshot       *Snapshot
	Classification *Classification

	// Aligned is Visit <= Encounter, with a proof.
	Aligned *Verdict
	// NotAligned is Visit <= Doctor, with a verified countermodel.
	NotAligned *Verdict
	// NotSubject is Visit <= Person. The existence of a Patient successor does
	// not put the source object into Person.
	NotSubject *Verdict
}

// VocabularyAlignmentExample demonstrates the intended host integration: build
// an immutable snapshot once, classify once, then ask for proofs or
// countermodels for individual vocabulary mappings.
func VocabularyAlignmentExample() (*AlignmentExample, error) {
	concepts := []string{"Visit", "Encounter", "Patient", "Person", "Doctor", "Clinician"}
	relations := []string{"subject"}
	axioms := []Axiom{
		Include("align-visit-encounter", "Visit", "Encounter"),
		Include("align-encounter-visit", "Encounter", "Visit"),
		Exists("encounter-subject", "Encounter", "subject", "Patient"),
		Include("patient-person", "Patient", "Person"),
		Include("doctor-clinician", "Doctor", "Clinician"),
		Intersect("encounter-clinician-disjoint", "Encounter", "Clinician", Bottom),
	}

	snapshot, err := NewSnapshot(Vocabulary{Concepts: concepts, Relations: relations}, axioms)
	if err != nil {
		return nil, err
	}
	classification := snapshot.Classify()

	aligned, err := classification.Explain("Visit", "Encounter")
	if err != nil {
		return nil, err
	}
	notAligned, err := classification.Explain("Visit", "Doctor")
	if err != nil {
		return nil, err
	}
	notSubject, err := classification.Explain("Visit", "Person")
	if err != nil {
		return nil, err
	}
	return &AlignmentExample{
		Snapshot:       snapshot,
		Classification: classification,
		Aligned:        aligned,
		NotAligned:     notAligned,
		NotSubject:     notSubject,
	}, nil
}
