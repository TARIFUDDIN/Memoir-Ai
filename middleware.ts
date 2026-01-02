import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'

// Define protected routes
const isProtectedRoute = createRouteMatcher([
    '/home(.*)', 
    '/dashboard(.*)', 
    '/meeting(.*)',
    '/settings(.*)',
    '/integrations(.*)'
])

export default clerkMiddleware(async (auth, req) => {
    const { userId, redirectToSignIn } = await auth()

    // ⛔️ TEMPORARY FIX: Disable Rate Limiting in Production to unblock the Bot
    // We simply skip the Redis check entirely.
    
    // ---------------------------------------------------------
    // AUTHENTICATION ONLY
    // ---------------------------------------------------------
    if (!userId && isProtectedRoute(req)) {
        return redirectToSignIn()
    }

    return NextResponse.next()
})

export const config = {
    matcher: [
        '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
        '/(api|trpc)(.*)',
    ],
}