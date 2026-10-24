// Where the (already encrypted) records are kept. One tiny interface, three homes:
//  - MemoryPersist       tests
//  - LocalStoragePersist the browser preview only (never real data)
//  - SqlitePersist       the phone (src/platform/sqlite.js), durable and not lost when the WebView clears its cache
//
// interface: get(key) -> string|null, set(key, text), del(key), keys(prefix) -> string[], clear()

export class MemoryPersist {
  constructor() {
    this.data = new Map();
  }
  async get(key) {
    return this.data.has(key) ? this.data.get(key) : null;
  }
  async set(key, text) {
    this.data.set(key, text);
  }
  async del(key) {
    this.data.delete(key);
  }
  async keys(prefix = '') {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix));
  }
  async clear() {
    this.data.clear();
  }
}

export class LocalStoragePersist {
  constructor(prefix = 'absales:data:') {
    this.prefix = prefix;
  }
  async get(key) {
    return localStorage.getItem(this.prefix + key);
  }
  async set(key, text) {
    localStorage.setItem(this.prefix + key, text);
  }
  async del(key) {
    localStorage.removeItem(this.prefix + key);
  }
  async keys(prefix = '') {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i);
      if (name.startsWith(this.prefix + prefix)) out.push(name.slice(this.prefix.length));
    }
    return out;
  }
  async clear() {
    for (const key of await this.keys('')) localStorage.removeItem(this.prefix + key);
  }
}
