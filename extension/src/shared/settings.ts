export interface Settings {
  serverUrl: string;
  apiKey: string;
  profileId: string;
  captureMic: boolean;
}

// Filled in at build time from backend/.env (see vite.config.ts).
declare const __MAYAMI_DEFAULT_SERVER_URL__: string;
declare const __MAYAMI_DEFAULT_API_KEY__: string;

export const DEFAULTS: Settings = {
  serverUrl: __MAYAMI_DEFAULT_SERVER_URL__,
  apiKey: __MAYAMI_DEFAULT_API_KEY__,
  profileId: "default",
  captureMic: true,
};

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  const settings = { ...DEFAULTS, ...stored } as Settings;
  // A saved empty key never helps (a server without a key accepts any token), so use the build's.
  if (!settings.apiKey) settings.apiKey = DEFAULTS.apiKey;
  return settings;
}

// "ws://host:8000" -> "http://host:8000" for the REST endpoints.
export function httpBase(serverUrl: string): string {
  return serverUrl.replace(/^ws/, "http").replace(/\/+$/, "");
}
