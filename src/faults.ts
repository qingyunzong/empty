/** Deterministic fault injector: throws on the first `times` invocations. */
export function failTimes(times: number, message = "injected fault"): () => void {
  let left = times;
  return () => {
    if (left > 0) {
      left -= 1;
      throw new Error(message);
    }
  };
}
