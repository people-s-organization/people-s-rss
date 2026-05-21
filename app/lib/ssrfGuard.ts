import { promises as dns } from "node:dns";
import net from "node:net";

export class SSRFError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "SSRFError";
    this.status = status;
  }
}

function ipv4ToBytes(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out.push(n);
  }
  return out;
}

function isPrivateIPv4(ip: string): boolean {
  const b = ipv4ToBytes(ip);
  if (!b) return true;
  const [a, c] = b;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && c === 254) return true;
  if (a === 172 && b[1] >= 16 && b[1] <= 31) return true;
  if (a === 192 && b[1] === 168) return true;
  if (a === 192 && b[1] === 0 && b[2] === 0) return true;
  if (a === 192 && b[1] === 0 && b[2] === 2) return true;
  if (a === 198 && (b[1] === 18 || b[1] === 19)) return true;
  if (a === 198 && b[1] === 51 && b[2] === 100) return true;
  if (a === 203 && b[1] === 0 && b[2] === 113) return true;
  if (a >= 224) return true;
  if (a === 100 && b[1] >= 64 && b[1] <= 127) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  if (lower.startsWith("ff")) return true;
  if (lower.startsWith("::ffff:")) {
    const v4 = lower.slice(7);
    return isPrivateIPv4(v4);
  }
  if (lower.startsWith("64:ff9b::")) return true;
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true;
}

export type AssertUrlOptions = {
  forceHttps?: boolean;
  allowedProtocols?: string[];
};

export async function assertPublicHttpUrl(
  raw: string,
  opts: AssertUrlOptions = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SSRFError("Invalid url");
  }
  const allowed = opts.allowedProtocols ?? (opts.forceHttps ? ["https:"] : ["http:", "https:"]);
  if (!allowed.includes(url.protocol)) {
    throw new SSRFError(`Unsupported protocol ${url.protocol}`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname) throw new SSRFError("Missing hostname");

  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new SSRFError("Private or reserved IP not allowed");
    }
    return url;
  }

  let resolved: { address: string; family: number }[];
  try {
    resolved = await dns.lookup(hostname, { all: true });
  } catch {
    throw new SSRFError("Cannot resolve hostname");
  }
  if (resolved.length === 0) throw new SSRFError("Cannot resolve hostname");
  for (const r of resolved) {
    if (isPrivateAddress(r.address)) {
      throw new SSRFError("Hostname resolves to private/reserved IP");
    }
  }
  return url;
}
