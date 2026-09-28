/** Простое ограничение частоты на экземпляр: N сообщений за окно на клиента (FS-WGT-01). */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}
  allow(key: string): boolean {
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.limit) return false;
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 50_000) this.hits.clear();
    return true;
  }
}
