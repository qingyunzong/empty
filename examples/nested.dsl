# three-level nested experiment with shadowing and raw observations
experiment outer {
  let rate = 1;
  let note = `outer obs (raw) # literal`;
  experiment mid {
    let rate = 2;
    experiment inner {
      let rate = 3;
      let derived = rate * 10;
      override rate = 4; # corrects nearest binding: inner's rate
    }
  }
}
