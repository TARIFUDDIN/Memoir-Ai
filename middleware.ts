import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { ratelimit } from '@/lib/ratelimit' 

// Define protected routes
const isProtectedRoute = createRouteMatcher([
    '/home(.*)', 
    '/dashboard(.*)', 
    '/meeting(.*)',
    '/settings(.*)',
    '/integrations(.*)'
])

// Define API routes that need rate limiting (exclude webhooks!)
const isApiRoute = createRouteMatcher(['/api/user(.*)', '/api/rag(.*)', '/api/meetings(.*)']) 

export default clerkMiddleware(async (auth, req) => {
    const { userId, redirectToSignIn } = await auth()

    // ---------------------------------------------------------
    // 1. RATE LIMITING (Protect APIs)
    // ---------------------------------------------------------
    // ✅ FIX: Skip Rate Limiting completely in Development to prevent "Fetch Failed" errors
    if (process.env.NODE_ENV !== 'development' && isApiRoute(req) && userId) {
        try {
            // Use userId as key. If not logged in, use IP.
            const identifier = userId || req.headers.get("x-forwarded-for") || "ip_unknown"
            
            const { success, limit, reset, remaining } = await ratelimit.limit(identifier)

            if (!success) {
                return NextResponse.json(
                    { error: "Too many requests. Slow down." },
                    { 
                        status: 429,
                        headers: {
                            "X-RateLimit-Limit": limit.toString(),
                            "X-RateLimit-Remaining": remaining.toString(),
                            "X-RateLimit-Reset": reset.toString()
                        }
                    }
                )
            }
        } catch (err) {
            console.error("Rate Limit Error:", err)
            // Fail open: If Redis is down, let the request pass so we don't block users
        }
    }

    // ---------------------------------------------------------
    // 2. AUTHENTICATION (Protect Pages)
    // ---------------------------------------------------------
    if (!userId && isProtectedRoute(req)) {
        return redirectToSignIn()
    }

    return NextResponse.next()
})

export const config = {
    matcher: [
        // Skip Next.js internals and static files
        '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
        // Always run for API routes
        '/(api|trpc)(.*)',
    ],
}