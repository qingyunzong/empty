export interface ObjectVersion {
  objectId: string;
  version: number;
  blockIds: string[];
  publishedAtSeq: number;
  publishedAtTick: number;
}

export class PublishedStore {
  private readonly objects = new Map<string, ObjectVersion[]>();

  publish(objectId: string, blockIds: string[], seq: number, tick: number): ObjectVersion {
    const history = this.objects.get(objectId) ?? [];
    const version: ObjectVersion = {
      objectId,
      version: history.length + 1,
      blockIds: [...blockIds],
      publishedAtSeq: seq,
      publishedAtTick: tick,
    };
    history.push(version);
    this.objects.set(objectId, history);
    return version;
  }

  history(objectId: string): readonly ObjectVersion[] {
    return this.objects.get(objectId) ?? [];
  }

  latest(objectId: string): ObjectVersion | null {
    const history = this.objects.get(objectId);
    return history && history.length > 0 ? history[history.length - 1]! : null;
  }
}
