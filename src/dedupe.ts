export class TTLSet {
  private store = new Map<string, number>();
  constructor(private ttlMs: number) {}

  has(id: string | undefined): boolean {
    if (!id) return false;
    const exp = this.store.get(id);
    if (exp && exp > Date.now()) return true;
    if (exp) this.store.delete(id);
    return false;
  }

  add(id: string | undefined) {
    if (!id) return;
    this.store.set(id, Date.now() + this.ttlMs);
  }

  sweep() {
    const now = Date.now();
    for (const [k, exp] of this.store.entries()) {
      if (exp <= now) this.store.delete(k);
    }
  }
}

