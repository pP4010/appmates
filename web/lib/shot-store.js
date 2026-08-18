/** Screenshots persisted across reloads — IndexedDB (not localStorage) since
 * entries are image files, not strings. Whole-store overwrite on every save:
 * simplest correct way to keep order in sync with the on-screen wall, and
 * cheap at the handful of files this tool deals with. */

const DB_NAME = 'appmates';
const STORE = 'screenshots';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'order' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveShots(files) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    const tx = store.transaction;
    store.clear();
    files.forEach((file, order) => store.put({ order, name: file.name, type: file.type, blob: file }));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadShots() {
  const db = await openDb();
  const records = await new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return records.sort((a, b) => a.order - b.order).map((r) => new File([r.blob], r.name, { type: r.type }));
}
