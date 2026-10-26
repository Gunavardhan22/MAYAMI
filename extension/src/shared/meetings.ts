// The overlay is only injected on supported meeting sites.
export const MEETING_MATCHES = [
  "https://meet.google.com/*",
  "https://*.zoom.us/*",
  "https://teams.microsoft.com/*",
  "https://teams.live.com/*",
];

const MEETING_HOSTS = [/^meet\.google\.com$/, /(^|\.)zoom\.us$/, /^teams\.microsoft\.com$/, /^teams\.live\.com$/];

export function isMeetingUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && MEETING_HOSTS.some((re) => re.test(hostname));
  } catch {
    return false;
  }
}
