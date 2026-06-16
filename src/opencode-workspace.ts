// OpenCode workspace usage fetcher stub.
export interface WorkspaceWithKeys {
  id: string;
  name: string;
  slug: string;
  keys: { id: string; key: string; name: string; enabled?: boolean }[];
  keyNames: { keyID: string; name: string }[];
  usage: { rolling: number; weekly: number; monthly: number };
}

export async function fetchAllWorkspacesWithKeysAndUsage(_sessionCookie?: string): Promise<WorkspaceWithKeys[]> {
  return [];
}
