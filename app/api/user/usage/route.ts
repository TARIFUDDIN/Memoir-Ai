import { NextResponse } from 'next/server'

export async function GET() {
    return NextResponse.json({
        currentPlan: 'premium',
        subscriptionStatus: 'active',
        meetingsThisMonth: 0,
        chatMessagesToday: 0,
        billingPeriodStart: new Date().toISOString()
    })
}
