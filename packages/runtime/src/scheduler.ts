/**
 * Internal: engine-wide node slots (runtime.md §3). FIFO across runs; a request whose node
 * type is at its own limit does not block requests behind it.
 */

export interface SlotRequest {
  nodeType: string;
  /** Per-type limit (definition `concurrency`), if any. */
  limit: number | undefined;
  /** Called synchronously when the slot is granted. */
  start(): void;
}

export class Scheduler {
  private used = 0;
  private readonly perType = new Map<string, number>();
  private readonly queue: SlotRequest[] = [];
  private pumping = false;
  private again = false;

  constructor(private readonly concurrency: number) {}

  request(req: SlotRequest): void {
    this.queue.push(req);
    this.pump();
  }

  /** Removes a request that has not been granted. Returns `true` if it was waiting. */
  withdraw(req: SlotRequest): boolean {
    const i = this.queue.indexOf(req);
    if (i < 0) return false;
    this.queue.splice(i, 1);
    return true;
  }

  release(nodeType: string): void {
    this.used -= 1;
    this.perType.set(nodeType, (this.perType.get(nodeType) ?? 1) - 1);
    this.pump();
  }

  private pump(): void {
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.again = false;
        for (;;) {
          if (this.used >= this.concurrency) break;
          const index = this.queue.findIndex((r) => r.limit === undefined || (this.perType.get(r.nodeType) ?? 0) < r.limit);
          if (index < 0) break;
          const [req] = this.queue.splice(index, 1);
          if (!req) break;
          this.used += 1;
          this.perType.set(req.nodeType, (this.perType.get(req.nodeType) ?? 0) + 1);
          req.start();
        }
      } while (this.again);
    } finally {
      this.pumping = false;
    }
  }
}
