import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

const handle = createMiddleware(routing);

export function proxy(request: Parameters<typeof handle>[0]) {
  return handle(request);
}

export const config = {
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
