const ABSOLUTE_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const BARE_HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i;

function shouldTreatAsBareHost(value: string): boolean {
  return (
    !ABSOLUTE_SCHEME.test(value) &&
    !value.startsWith("//") &&
    !value.startsWith("/") &&
    !value.startsWith("./") &&
    !value.startsWith("../") &&
    !value.startsWith("#") &&
    !value.startsWith("?") &&
    BARE_HOST.test(value)
  );
}

export function normalizeHttpUrl(raw: string, baseUrl?: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  const candidate = shouldTreatAsBareHost(value) ? `https://${value}` : value;
  try {
    const parsed = baseUrl ? new URL(candidate, baseUrl) : new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function normalizeMaybeEncodedHttpUrl(
  raw: string,
  baseUrl?: string,
): string | null {
  const candidates = [raw];

  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw) candidates.push(decoded);
  } catch {}

  try {
    const latest = candidates[candidates.length - 1];
    const decodedTwice = decodeURIComponent(latest);
    if (decodedTwice !== latest) candidates.push(decodedTwice);
  } catch {}

  for (const candidate of candidates) {
    const normalized = normalizeHttpUrl(candidate, baseUrl);
    if (normalized) return normalized;
  }

  return null;
}
