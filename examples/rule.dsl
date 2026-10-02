# Sequential sampling plan for batch B2024-001.
rule "aql-sequential" version 1 {
  param batch_size: quantity
  param sampled: quantity
  param defects: quantity
  param severity: level

  const max_defects: quantity = 2
  const min_sample: quantity = 5
  const max_rate: ratio = 10%
  const effective_from: date = 2024-01-01
  const batch_id: batch = B2024-001

  # too many defects, or any critical defect: reject outright
  when defects > max_defects or severity >= critical => REJECT
  # defect rate above the negotiated limit: reject
  when let rate: ratio = defects / sampled in sampled > 0 and rate > max_rate => REJECT
  # enough samples drawn and defects within threshold: accept
  when sampled >= min_sample and defects <= max_defects => ACCEPT
  # otherwise keep sampling: CONTINUE is a legal pending verdict
  otherwise => CONTINUE
}
