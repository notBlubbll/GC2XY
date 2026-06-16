// OpenCode workspace usage fetcher stub.
export interface WorkspaceWithKeys {
  id: string;
  name: string;
  keys: { id: string; key: string; name: string; enabled?: boolean }[];
  usage: { rolling: number; weekly: number; monthly: number };
}

export async function fetchAllWorkspacesWithKeysAndUsage(): Promise<WorkspaceWithKeys[]> {
  return [];
}
