# global defaults
let x = 1;
let note = `raw obs (alpha) [beta] # not a comment ; still raw`;

experiment outer {
  let x = 2;
  let y = x + 10;        # sees outer x
  experiment mid {
    let x = 3;
    experiment inner {
      let z = x * 2;     # sees mid x
    }
  }
}
