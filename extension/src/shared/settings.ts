export interface Settings {
  serverUrl: string;
  apiKey: string;
  profileId: string;
  captureMic: boolean;
}

export const DEFAULTS: Settings = {
  serverUrl: "ws://localhost:8000",
  apiKey: "",
  profileId: "default",
  captureMic: true,
};

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored } as Settings;
}

// "ws://host:8000" -> "http://host:8000" for the REST endpoints.
export function httpBase(serverUrl: string): string {
  return serverUrl.replace(/^ws/, "http").replace(/\/+$/, "");
}
