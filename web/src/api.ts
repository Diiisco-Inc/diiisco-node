import type { NodeProfile, DirectoryEntry } from './types';

export class NotFoundError extends Error {}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 404) throw new NotFoundError(`Not found: ${url}`);
  if (!res.ok) throw new Error(`Request failed (${res.status}): ${url}`);
  return res.json() as Promise<T>;
}

export const getOwnProfile = () => getJson<NodeProfile>('/node.json');

export const getDirectory = async (): Promise<DirectoryEntry[]> => {
  const body = await getJson<{ object: string; data: DirectoryEntry[] }>('/nodes.json');
  return body.data;
};

export const getNodeProfile = (peerId: string) =>
  getJson<NodeProfile>(`/nodes/${encodeURIComponent(peerId)}.json`);
