import type { MlpPolicyArtifact, PolicyArtifact, QTableArtifact } from "./types";
import { isMlpPolicy, isQTablePolicy } from "./types";

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

export async function savePolicy(policy: PolicyArtifact) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(policy);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  return policy;
}

export async function listPolicies(): Promise<PolicyArtifact[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).getAll();
    request.onsuccess = () => resolve((request.result as PolicyArtifact[])
      .filter((policy) => policy.schemaVersion === 2 || (policy.schemaVersion === 3 && (policy as MlpPolicyArtifact).kind === "mlp"))
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

export async function getPolicyForMode(viewers: 1 | 2, rewardMode: QTableArtifact["profile"]["rewardMode"]) {
  const policies = (await listPolicies()).filter(isQTablePolicy);
  const activeId = localStorage.getItem(ACTIVE);
  return policies.find((p) => p.id === activeId && p.profile.viewers === viewers && p.profile.rewardMode === rewardMode)
    ?? policies.find((p) => p.profile.viewers === viewers && p.profile.rewardMode === rewardMode);
}

export async function getMlpPolicyForMode(viewers: 1 | 2, rewardMode: QTableArtifact["profile"]["rewardMode"]) {
  const policies = (await listPolicies()).filter(isMlpPolicy);
  const activeId = localStorage.getItem(ACTIVE);
  const matches = (p: MlpPolicyArtifact) => p.profile.viewers.includes(viewers) && p.profile.rewardModes.includes(rewardMode);
  return policies.find((p) => p.id === activeId && matches(p)) ?? policies.find(matches);
}
