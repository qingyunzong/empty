// AQL-style lot sampling rule, level II.
// Decides ACCEPT / REJECT / CONTINUE from batch size, samples taken so far
// and cumulative defects. CONTINUE means "keep sampling": a legitimate
// pending state, never a failure.
rule "AQL-L2" version 3 effective 2025-01-01 {
  param batch_size: quantity
  param sampled: quantity
  param defects: quantity
  param worst: defect_level

  let sample_size: quantity = max(1, floor(batch_size * 10%))
  let accept_max: quantity = floor(sample_size * 5%)

  decide {
    when worst >= critical -> REJECT
    when defects >= accept_max + 1 -> REJECT
    when sampled >= sample_size and defects <= accept_max -> ACCEPT
    otherwise -> CONTINUE
  }
}
