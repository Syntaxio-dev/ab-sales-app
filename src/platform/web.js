import { LocalStoragePersist } from '../data/persist.js';

// The browser preview. Only for looking at the screens: browser storage cannot give the protection a phone gives
// (the "device secret" sits in the same place as the data), so the app shows a warning banner here.

class LocalSecrets {
  constructor(prefix = 'absales:secret:') {
    this.prefix = prefix;
  }
  async get(key) {
    return localStorage.getItem(this.prefix + key);
  }
  async set(key, value) {
    localStorage.setItem(this.prefix + key, value);
  }
  async remove(key) {
    localStorage.removeItem(this.prefix + key);
  }
  async clear() {
    for (const name of Object.keys(localStorage)) if (name.startsWith(this.prefix)) localStorage.removeItem(name);
  }
}

export async function createWebPlatform() {
  return {
    native: false,
    secrets: new LocalSecrets(),
    persist: new LocalStoragePersist(),

    pickPhoto(source) {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/jpeg,image/png,image/webp';
        if (source === 'camera') input.capture = 'environment';

        input.addEventListener('change', async () => {
          const file = input.files?.[0];
          resolve(file ? new Uint8Array(await file.arrayBuffer()) : null);
        });
        input.addEventListener('cancel', () => resolve(null));
        input.click();
      });
    },

    // browser: download the file
    async shareFile(name, text, mime) {
      const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },

    async cleanExports() {},

    onAppState(listener) {
      document.addEventListener('visibilitychange', () => listener(document.visibilityState === 'visible'));
    },

    onBackButton() {},
  };
}
