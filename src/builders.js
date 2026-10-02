import { sha256, canonical } from './hash.js';

// A builder receives inputs as [{edge, target, hash}] sorted by edge id and
// returns hex digest material. The artifact hash additionally binds the
// builder name, so two builders never collide over the same inputs.
export const BUILDERS = {
  concat(inputs) {
    return sha256(inputs.map((i) => i.hash).join(''));
  },
  first(inputs) {
    return inputs.length > 0 ? inputs[0].hash : sha256('first:empty');
  },
  count(inputs) {
    return sha256(`count:${inputs.length}`);
  },
  xor(inputs) {
    const acc = Buffer.alloc(32);
    for (const input of inputs) {
      const bytes = Buffer.from(input.hash, 'hex');
      for (let i = 0; i < 32; i += 1) acc[i] ^= bytes[i];
    }
    return acc.toString('hex');
  },
  manifest(inputs) {
    return sha256(canonical(inputs.map((i) => [i.edge, i.target, i.hash])));
  },
};

export function computeArtifactHash(builder, inputs) {
  return sha256(`artifact\0${builder}\0${BUILDERS[builder](inputs)}`);
}
