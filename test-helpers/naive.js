// Naive replayer: the simplest possible model of the spec, used as the
// cross-check oracle. append commits events one page at a time (one event
// per page in the cross-check setup); a crash after k fsyncs keeps exactly
// the first k events of the batch; recovery never changes committed state.
export class NaiveLog {
  constructor() {
    this.events = [];
  }

  appendBatch(batch, crashAfterFsyncs = Infinity) {
    const keep = Math.min(crashAfterFsyncs, batch.length);
    for (let i = 0; i < keep; i++) {
      this.events.push({ ...batch[i], seq: this.events.length + 1 });
    }
  }

  recover() {
    return this.events;
  }
}
