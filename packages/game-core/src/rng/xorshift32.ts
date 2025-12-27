export class Xorshift32 {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  get state(): number {
    return this.#state;
  }

  nextUint32(): number {
    let x = this.#state >>> 0;
    x ^= (x << 13) >>> 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0;
    this.#state = x >>> 0;
    return this.#state;
  }
}
