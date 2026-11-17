export class RetryTokenBucket {
  private available: number;

  constructor(private readonly capacity: number) {
    this.available = capacity;
  }

  tryAcquire(): boolean {
    if (this.available <= 0) return false;
    this.available -= 1;
    return true;
  }

  refund(): void {
    if (this.available < this.capacity) this.available += 1;
  }

  get remaining(): number {
    return this.available;
  }
}
