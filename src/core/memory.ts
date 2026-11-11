/**
 * Sparse, little-endian, byte-addressed 32-bit memory.
 *
 * Pages are allocated on first write; reads of untouched memory return 0.
 * Misaligned accesses are allowed (the interpreter is a functional oracle,
 * not a trap model).
 */

const PAGE_BITS = 12;
const PAGE_SIZE = 1 << PAGE_BITS;
const PAGE_MASK = PAGE_SIZE - 1;

export class Memory {
  private readonly pages = new Map<number, Uint8Array>();

  private page(addr: number, create: boolean): Uint8Array | undefined {
    const key = (addr >>> 0) >>> PAGE_BITS;
    let p = this.pages.get(key);
    if (!p && create) {
      p = new Uint8Array(PAGE_SIZE);
      this.pages.set(key, p);
    }
    return p;
  }

  read8(addr: number): number {
    const a = addr >>> 0;
    return this.page(a, false)?.[a & PAGE_MASK] ?? 0;
  }

  write8(addr: number, value: number): void {
    const a = addr >>> 0;
    this.page(a, true)![a & PAGE_MASK] = value & 0xff;
  }

  /** Unsigned 16-bit read. */
  read16(addr: number): number {
    return this.read8(addr) | (this.read8(addr + 1) << 8);
  }

  write16(addr: number, value: number): void {
    this.write8(addr, value);
    this.write8(addr + 1, value >>> 8);
  }

  /** 32-bit read, returned as a signed int32. */
  read32(addr: number): number {
    return (
      this.read8(addr) |
      (this.read8(addr + 1) << 8) |
      (this.read8(addr + 2) << 16) |
      (this.read8(addr + 3) << 24)
    );
  }

  write32(addr: number, value: number): void {
    this.write8(addr, value);
    this.write8(addr + 1, value >>> 8);
    this.write8(addr + 2, value >>> 16);
    this.write8(addr + 3, value >>> 24);
  }

  writeBytes(addr: number, bytes: Uint8Array): void {
    bytes.forEach((b, i) => this.write8(addr + i, b));
  }

  readBytes(addr: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = this.read8(addr + i);
    return out;
  }

  clone(): Memory {
    const m = new Memory();
    for (const [k, p] of this.pages) m.pages.set(k, p.slice());
    return m;
  }

  /** Non-zero bytes as [address, value] pairs, sorted. Handy for golden comparisons. */
  nonZeroBytes(): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    const keys = [...this.pages.keys()].sort((a, b) => a - b);
    for (const k of keys) {
      const p = this.pages.get(k)!;
      for (let i = 0; i < PAGE_SIZE; i++) {
        if (p[i] !== 0) out.push([((k << PAGE_BITS) | i) >>> 0, p[i]!]);
      }
    }
    return out;
  }
}
