// IndexedDB persistence for saved circuits.

const DB_NAME = 'nandmorphic';
const STORE = 'saves';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const result = fn(store);
    tx.oncomplete = () => resolve(result === store ? undefined : result);
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveProject(name, data) {
  const id = `save_${Date.now()}`;
  await withStore('readwrite', (store) => store.put({ id, name, data, savedAt: Date.now() }));
  return id;
}

export async function loadProject(id) {
  const record = await withStore('readonly', (store) => store.get(id));
  return record ? record.data : null;
}

export async function listProjects() {
  const records = await withStore('readonly', (store) => store.getAll());
  return (records || []).sort((a, b) => b.savedAt - a.savedAt);
}

export async function deleteProject(id) {
  await withStore('readwrite', (store) => store.delete(id));
}