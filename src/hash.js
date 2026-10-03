import { createHash } from 'node:crypto';

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashFile(content) {
  return sha256(`file${content}`);
}

export function hashArtifact(builder, sortedInputs) {
  return sha256(canonical({ type: 'artifact', builder, inputs: sortedInputs }));
}

export function hashRelease(sortedInputs) {
  return sha256(canonical({ type: 'release', inputs: sortedInputs }));
}

export function defSig(artifact) {
  return canonical({ builder: artifact.builder, inputs: [...artifact.inputs].sort() });
}
