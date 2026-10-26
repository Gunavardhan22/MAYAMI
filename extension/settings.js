export const DEFAULTS = {
  serverUrl: "ws://localhost:8000",
  apiKey: "",
  profileId: "default",
  captureMic: true,
};

export async function loadSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(Object.keys(DEFAULTS))) };
}

// "ws://host:8000" -> "http://host:8000" for the REST endpoints.
export function httpBase(serverUrl) {
  return serverUrl.replace(/^ws/, "http").replace(/\/+$/, "");
}
