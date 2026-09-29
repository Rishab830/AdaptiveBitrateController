import type { QTableArtifact } from "./types";

const DB_NAME = "abr-policies";
const STORE = "policies";
const ACTIVE = "abr-active-policy";

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function savePolicy(policy: QTableArtifact) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(policy);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  return policy;
}

export async function listPolicies(): Promise<QTableArtifact[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result
      .filter((policy: { schemaVersion?: number }) => policy.schemaVersion === 2)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    request.onerror = () => reject(request.error);
  });
}

export async function deletePolicy(id: string) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE, "readwrite").objectStore(STORE).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  if (localStorage.getItem(ACTIVE) === id) localStorage.removeItem(ACTIVE);
}

export function setActivePolicy(id: string) { localStorage.setItem(ACTIVE, id); }

export async function getActivePolicy(viewers?: 1 | 2) {
  const id = localStorage.getItem(ACTIVE);
  const policies = await listPolicies();
  const active = policies.find((policy) => policy.id === id && (!viewers || policy.profile.viewers === viewers));
  return active ?? policies.find((policy) => !viewers || policy.profile.viewers === viewers);
}

export async function getPolicyForMode(viewers: 1 | 2, rewardMode: QTableArtifact["profile"]["rewardMode"]) {
  const policies = await listPolicies();
  const activeId = localStorage.getItem(ACTIVE);
  return policies.find((policy) => policy.id === activeId && policy.profile.viewers === viewers && policy.profile.rewardMode === rewardMode)
    ?? policies.find((policy) => policy.profile.viewers === viewers && policy.profile.rewardMode === rewardMode);
}
