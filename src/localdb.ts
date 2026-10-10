/* Tiny IndexedDB wrapper: one store for app data, one for proof files. */

const DB_NAME = "warehouse-local";
const DB_VERSION = 1;

export type StoreName = "kv" | "blobs";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains("kv")) {
          db.createObjectStore("kv");
        }

        if (!db.objectStoreNames.contains("blobs")) {
          db.createObjectStore("blobs");
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(
          request.error ?? new Error("Could not open the local database")
        );
    });
  }

  return dbPromise;
}

async function withStore<T>(
  name: StoreName,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest
): Promise<T> {
  const db = await openDb();

  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(name, mode);
    const request = action(transaction.objectStore(name));

    transaction.oncomplete = () => resolve(request.result as T);
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Local database error"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Local database error"));
  });
}

export function idbGet<T>(
  store: StoreName,
  key: string | number
): Promise<T | undefined> {
  return withStore<T | undefined>(store, "readonly", (s) => s.get(key));
}

export function idbPut(
  store: StoreName,
  key: string | number,
  value: unknown
): Promise<void> {
  return withStore<void>(store, "readwrite", (s) => s.put(value, key));
}

export function idbDelete(
  store: StoreName,
  key: string | number
): Promise<void> {
  return withStore<void>(store, "readwrite", (s) => s.delete(key));
}

export function idbClear(store: StoreName): Promise<void> {
  return withStore<void>(store, "readwrite", (s) => s.clear());
}