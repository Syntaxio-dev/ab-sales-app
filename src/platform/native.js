import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { registerPlugin } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { Camera, CameraDirection, CameraResultType, CameraSource } from '@capacitor/camera';
import { Geolocation } from '@capacitor/geolocation';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';

import { fromBase64 } from '../security/crypto.js';

// The phone: the Android Keystore backed secret store, SQLite for the (already encrypted) records,
// the system camera / photo picker, and the system share sheet.

// our own small plugin (android/.../CallLogReaderPlugin.java): reads the call history after the person allowed it
const CallLogReader = registerPlugin('CallLogReader');

const DB = 'absales';
const EXPORT_DIR = 'exports';

// ---- secrets (salt, device secret, wrapped data key, PIN attempt counter) ---------------

class KeystoreSecrets {
  async init() {
    await SecureStorage.setKeyPrefix('absales_');
  }
  async get(key) {
    const value = await SecureStorage.get(key);
    return typeof value === 'string' ? value : null;
  }
  async set(key, value) {
    await SecureStorage.set(key, value);
  }
  async remove(key) {
    await SecureStorage.remove(key);
  }
  async clear() {
    await SecureStorage.clear();
  }
}

// ---- records -----------------------------------------------------------------

class SqlitePersist {
  #db = null;

  async init() {
    const sqlite = new SQLiteConnection(CapacitorSQLite);
    const consistent = (await sqlite.checkConnectionsConsistency()).result;
    const exists = (await sqlite.isConnection(DB, false)).result;

    this.#db = consistent && exists ? await sqlite.retrieveConnection(DB, false) : await sqlite.createConnection(DB, false, 'no-encryption', 1, false);
    await this.#db.open();
    await this.#db.execute('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL);');
  }

  async get(key) {
    const { values } = await this.#db.query('SELECT v FROM kv WHERE k = ?;', [key]);
    return values?.length ? values[0].v : null;
  }
  async set(key, text) {
    await this.#db.run('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?);', [key, text]);
  }
  async del(key) {
    await this.#db.run('DELETE FROM kv WHERE k = ?;', [key]);
  }
  async keys(prefix = '') {
    const { values } = await this.#db.query('SELECT k FROM kv WHERE substr(k, 1, ?) = ?;', [prefix.length, prefix]);
    return (values ?? []).map((row) => row.k);
  }
  async clear() {
    await this.#db.run('DELETE FROM kv;');
  }
}

// ---- the platform object the app uses ------------------------------------------------

export async function createNativePlatform() {
  const secrets = new KeystoreSecrets();
  await secrets.init();
  const persist = new SqlitePersist();
  await persist.init();

  return {
    native: true,
    secrets,
    persist,

    // The call history, read only. state: 'granted' | 'denied' | 'prompt'. recent() gives [{ number, type, date (ms), duration (s) }].
    callLog: {
      available: true,
      async status() {
        return (await CallLogReader.status()).state;
      },
      async request() {
        return (await CallLogReader.request()).state;
      },
      async recent({ sinceMs, limit }) {
        return (await CallLogReader.recent({ sinceMs, limit })).calls ?? [];
      },
    },

    // The phone's position, read once (never watched). -> { lat, lng, accuracy_m }. Throws an Error whose .code is DENIED, OFF or TIMEOUT.
    async locate() {
      try {
        const status = await Geolocation.checkPermissions();
        if (status.location !== 'granted') {
          const asked = await Geolocation.requestPermissions({ permissions: ['location'] });
          if (asked.location !== 'granted') throw Object.assign(new Error('Location permission was not given.'), { code: 'DENIED' });
        }
        const p = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 });
        return { lat: p.coords.latitude, lng: p.coords.longitude, accuracy_m: Number.isFinite(p.coords.accuracy) ? p.coords.accuracy : null };
      } catch (error) {
        if (error?.code === 'DENIED') throw error;
        const text = String(error?.message ?? '');
        const code = /denied|permission/i.test(text) ? 'DENIED' : /disabled|unavailable|settings/i.test(text) ? 'OFF' : 'TIMEOUT';
        throw Object.assign(new Error(text || 'Could not read the location.'), { code });
      }
    },

    // source: 'camera' | 'gallery' | 'selfie' (front camera, never the gallery) -> Uint8Array of a JPEG, or null when the person cancelled
    async pickPhoto(source) {
      try {
        const photo = await Camera.getPhoto({
          quality: 70,
          width: 1600,
          resultType: CameraResultType.Base64,
          source: source === 'gallery' ? CameraSource.Photos : CameraSource.Camera,
          ...(source === 'selfie' ? { direction: CameraDirection.Front } : {}),
          correctOrientation: true,
          saveToGallery: false,
        });
        return photo.base64String ? fromBase64(photo.base64String) : null;
      } catch (error) {
        if (/cancel/i.test(String(error?.message))) return null;
        throw error;
      }
    },

    // The file is written to the app's private cache, handed to the share sheet, and removed on the next lock/start.
    async shareFile(name, text, mime) {
      const written = await Filesystem.writeFile({ path: `${EXPORT_DIR}/${name}`, data: text, directory: Directory.Cache, encoding: Encoding.UTF8, recursive: true });
      await Share.share({ title: name, dialogTitle: 'Share file', files: [written.uri] });
    },

    async cleanExports() {
      try {
        await Filesystem.rmdir({ path: EXPORT_DIR, directory: Directory.Cache, recursive: true });
      } catch {
        // nothing to clean
      }
    },

    // Called with (isActive) when the app goes to the background or comes back.
    onAppState(listener) {
      CapApp.addListener('appStateChange', ({ isActive }) => listener(isActive));
    },

    // Called when the phone's back button is pressed; return true if the press was used.
    onBackButton(listener) {
      CapApp.addListener('backButton', () => {
        if (!listener()) CapApp.minimizeApp();
      });
    },
  };
}
