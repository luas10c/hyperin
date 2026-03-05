export class LRUCache<K, V> {
  #max: number
  #cache: Map<K, V>

  constructor(max: number) {
    this.#max = max
    this.#cache = new Map()
  }

  get(key: K): V | undefined {
    if (!this.#cache.has(key)) return undefined

    // Move para o final (mais recente)
    const value = this.#cache.get(key)!
    this.#cache.delete(key)
    this.#cache.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    this.#cache.delete(key)

    if (this.#cache.size >= this.#max) {
      // Deleta o primeiro item (menos recente)
      this.#cache.delete(this.#cache.keys().next().value!)
    }

    this.#cache.set(key, value)
  }

  has(key: K): boolean {
    return this.#cache.has(key)
  }

  delete(key: K): void {
    this.#cache.delete(key)
  }

  clear(): void {
    this.#cache.clear()
  }

  get size(): number {
    return this.#cache.size
  }
}
