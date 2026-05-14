import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

// ✅ Protected UI routes ONLY (not APIs)
const isProtectedRoute = createRouteMatcher([
  "/home(.*)",
  "/dashboard(.*)",
  "/meeting(.*)",
  "/settings(.*)",
  "/integrations(.*)",
]);

// ✅ Public routes
const isPublicRoute = createRouteMatcher([
  "/api/webhooks(.*)",   // ✅ allow MeetingBaaS webhook
  "/api/meetings(.*)",   // ✅ allow API (we handle auth manually inside)
  "/sign-in(.*)",
  "/sign-up(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  const { userId, redirectToSignIn } = await auth();

  console.log(`🔒 Middleware: ${req.method} ${req.nextUrl.pathname}`);

  // ✅ Public routes → allow
  if (isPublicRoute(req)) {
    return NextResponse.next();
  }

  // ❌ Only block protected UI routes
  if (!userId && isProtectedRoute(req)) {
    return redirectToSignIn();
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    "/((?!_next|monitoring|.*\\..*).*)",
    "/(api|trpc)(.*)",
  ],
};
