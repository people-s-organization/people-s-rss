import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { routing } from "./i18n/routing";

const handle = createMiddleware(routing);
const CANONICAL_HOST = "rss.baomi.app";

function shouldRedirectToCanonical(host: string): boolean {
  if (!host || host === CANONICAL_HOST) return false;
  return (
    host.endsWith(".workers.dev") ||
    host.endsWith(".pages.dev") ||
    host.endsWith(".vercel.app")
  );
}

export function middleware(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  if (shouldRedirectToCanonical(host)) {
    const url = request.nextUrl.clone();
    url.protocol = "https:";
    url.host = CANONICAL_HOST;
    url.port = "";
    return NextResponse.redirect(url, 308);
  }

  return handle(request);
}

export const config = {
  matcher: ["/((?!api|_next|_vercel|cdn-cgi|.*\\..*).*)"],
};
