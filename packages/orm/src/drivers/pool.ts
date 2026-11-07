import { DEFAULT_POOL, type PoolOptions } from "./types";

type Factory<T> = {
  create(): Promise<T>;
  destroy(resource: T): Promise<void>;
  /** A resource that died while idle (its socket closed) is dropped instead of handed out. */
  isUsable(resource: T): boolean;
};

type Waiter<T> = { resolve(resource: T): void; reject(error: Error): void; timer: NodeJS.Timeout };

/**
 * A small pool for drivers that have none (tedious). It creates connections up to `max`, hands idle ones out first,
 * queues callers when all are busy, gives up after `acquireTimeoutMillis`, and closes connections idle for longer
 * than `idleTimeoutMillis`.
 */
export class ResourcePool<T> {
  readonly #factory: Factory<T>;
  readonly #max: number;
  readonly #idleTimeout: number;
  readonly #acquireTimeout: number;
  readonly #idle: Array<{ resource: T; timer: NodeJS.Timeout }> = [];
  readonly #waiting: Waiter<T>[] = [];
  #size = 0;
  #destroyed = false;

  constructor(factory: Factory<T>, options: PoolOptions = {}) {
    this.#factory = factory;
    this.#max = Math.max(1, options.max ?? DEFAULT_POOL.max);
    this.#idleTimeout = options.idleTimeoutMillis ?? DEFAULT_POOL.idleTimeoutMillis;
    this.#acquireTimeout = options.acquireTimeoutMillis ?? DEFAULT_POOL.acquireTimeoutMillis;
  }

  async acquire(): Promise<T> {
    if (this.#destroyed) throw new Error("Tenora: the connection pool was destroyed.");
    while (this.#idle.length) {
      const { resource, timer } = this.#idle.pop()!;
      clearTimeout(timer);
      if (this.#factory.isUsable(resource)) return resource;
      await this.#discard(resource);
    }
    if (this.#size < this.#max) return this.#create();
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter<T> = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiting.splice(this.#waiting.indexOf(waiter), 1);
          reject(
            new Error(
              `Tenora: waited ${this.#acquireTimeout} ms for a free connection; every connection in the pool is in use.`
            )
          );
        }, this.#acquireTimeout),
      };
      this.#waiting.push(waiter);
    });
  }

  async #create(): Promise<T> {
    this.#size += 1;
    try {
      return await this.#factory.create();
    } catch (error) {
      this.#size -= 1;
      this.#serveWaiter();
      throw error;
    }
  }

  async #discard(resource: T) {
    this.#size -= 1;
    await this.#factory.destroy(resource).catch(() => undefined);
  }

  /** After a slot frees up, a waiting caller gets a new connection. */
  #serveWaiter() {
    if (!this.#waiting.length || this.#size >= this.#max || this.#destroyed) return;
    const waiter = this.#waiting.shift()!;
    clearTimeout(waiter.timer);
    this.#create().then(waiter.resolve, waiter.reject);
  }

  async release(resource: T, broken = false): Promise<void> {
    if (broken || this.#destroyed || !this.#factory.isUsable(resource)) {
      await this.#discard(resource);
      this.#serveWaiter();
      return;
    }
    const waiter = this.#waiting.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(resource);
      return;
    }
    const timer = setTimeout(() => {
      const index = this.#idle.findIndex((entry) => entry.resource === resource);
      if (index !== -1) {
        this.#idle.splice(index, 1);
        void this.#discard(resource);
      }
    }, this.#idleTimeout);
    // An idle connection must not keep the process alive.
    timer.unref();
    this.#idle.push({ resource, timer });
  }

  async destroy(): Promise<void> {
    this.#destroyed = true;
    for (const waiter of this.#waiting.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Tenora: the connection pool was destroyed."));
    }
    const idle = this.#idle.splice(0);
    for (const { timer } of idle) clearTimeout(timer);
    await Promise.all(idle.map(({ resource }) => this.#discard(resource)));
  }
}
