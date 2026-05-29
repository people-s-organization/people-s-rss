import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { routing } from "./i18n/routing";

const handle = createMiddleware(routing);

const CANONICAL_HOST = "rss.baomi.app";

export function proxy(request: NextRequest) {
  // Send the production *.vercel.app system domain to the canonical domain.
  // Preview deployments (VERCEL_ENV !== "production") keep their own URLs so
  // branch previews stay reachable.
  const host = request.headers.get("host") ?? "";
  if (process.env.VERCEL_ENV === "production" && host.endsWith(".vercel.app")) {
    const url = request.nextUrl.clone();
    url.protocol = "https:";
    url.host = CANONICAL_HOST;
    url.port = "";
    return NextResponse.redirect(url, 308);
  }

  return handle(request);
}

export const config = {
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
