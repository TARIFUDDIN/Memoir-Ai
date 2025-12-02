const { PrismaClient } = require("@prisma/client")

const prisma = new PrismaClient()
exports.handler = async (event) => {
    try {
        const result = await prisma.user.updateMany({
            where: {
                subscriptionStatus: 'active'
            },
            data: {
                chatMessagesToday: 0
            }
        })

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'daily chat reset completed successfully',
                usersReset: result.count,
                timestamp: new Date().toISOString()
            })
        }

    } catch (error) {
        console.error('chat reset error:', error)

        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'failed to reset the chat messages',
                details: error.message,
                timestamp: new Date().toISOString()
            })
        }
    } finally {
        await prisma.$disconnect()
    }
}

async function syncAllUserCalendars() {
    try {
        const users = await prisma.user.findMany({
            where: {
                calendarConnected: true,
                googleAccessToken: { not: null }
            }
        })

        console.log(`Found ${users.length} users with connected calendars`)

        for (const user of users) {
            try {
                await syncUserCalendar(user)
            } catch (error) {
                console.error(`❌ Calendar sync failed for user ${user.id}:`, error.message)
            }
        }
    } catch (error) {
        console.error('❌ Error in syncAllUserCalendars:', error)
    }
}

async function syncUserCalendar(user) {
    try {
        let accessToken = user.googleAccessToken

        const now = new Date()
        const tokenExpiry = new Date(user.googleTokenExpiry)
        const tenMinutesFromNow = new Date(now.getTime() + 10 * 60 * 1000)

        if (tokenExpiry <= tenMinutesFromNow) {
            console.log(`🔄 Token expiring soon for ${user.clerkId}, refreshing...`)
            accessToken = await refreshGoogleToken(user)
            if (!accessToken) {
                console.log(`⚠️ Could not refresh token for ${user.clerkId}`)
                return
            }
        }

        const sevenDaysLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
        
        const response = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
            `timeMin=${now.toISOString()}&` +
            `timeMax=${sevenDaysLater.toISOString()}&` +
            `singleEvents=true&orderBy=startTime`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        )

        if (!response.ok) {
            if (response.status === 401) {
                console.log(`🔐 Unauthorized for ${user.clerkId}, disconnecting calendar`)
                await prisma.user.update({
                    where: { id: user.id },
                    data: { calendarConnected: false }
                })
                return
            }
            throw new Error(`Calendar API error: ${response.status}`)
        }

        const data = await response.json()
        const events = data.items || []

        console.log(`📊 Syncing ${events.length} events for user ${user.clerkId}`)

        for (const event of events) {
            if (event.status === 'cancelled') {
                await prisma.meeting.deleteMany({
                    where: { calendarEventId: event.id }
                })
                continue
            }

            await processCalendarEvent(user, event)
        }
    } catch (error) {
        console.error(`❌ Calendar sync error for ${user.clerkId}:`, error.message)
    }
}

async function refreshGoogleToken(user) {
    try {
        if (!user.googleRefreshToken) {
            console.log(`⚠️ No refresh token found for ${user.clerkId}`)
            await prisma.user.update({
                where: { id: user.id },
                data: { calendarConnected: false, googleAccessToken: null }
            })
            return null
        }

        const response = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                refresh_token: user.googleRefreshToken,
                grant_type: 'refresh_token'
            })
        })

        const tokens = await response.json()

        if (!tokens.access_token) {
            console.log(`⚠️ Failed to get access token for ${user.clerkId}`)
            await prisma.user.update({
                where: { id: user.id },
                data: { calendarConnected: false }
            })
            return null
        }

        await prisma.user.update({
            where: { id: user.id },
            data: {
                googleAccessToken: tokens.access_token,
                googleTokenExpiry: new Date(Date.now() + tokens.expires_in * 1000)
            }
        })

        console.log(`✅ Token refreshed for ${user.clerkId}`)
        return tokens.access_token
    } catch (error) {
        console.error(`❌ Token refresh error for ${user.clerkId}:`, error)
        await prisma.user.update({
            where: { id: user.id },
            data: { calendarConnected: false }
        })
        return null
    }
}

async function processCalendarEvent(user, event) {
    const meetingUrl = event.hangoutLink || event.conferenceData?.entryPoints?.[0]?.uri
    
    if (!meetingUrl || !event.start?.dateTime) {
        console.log(`⏭️ Skipping event ${event.id} - no meeting URL or start time`)
        return
    }

    const eventData = {
        calendarEventId: event.id,
        userId: user.id,
        title: event.summary || 'Untitled Meeting',
        description: event.description || null,
        meetingUrl: meetingUrl,
        startTime: new Date(event.start.dateTime),
        endTime: new Date(event.end.dateTime),
        attendees: event.attendees ? JSON.stringify(event.attendees.map(a => a.email)) : null,
        isFromCalendar: true,
        botScheduled: true
    }

    try {
        const existing = await prisma.meeting.findUnique({
            where: { calendarEventId: event.id }
        })

        if (existing) {
            await prisma.meeting.update({
                where: { calendarEventId: event.id },
                data: {
                    title: eventData.title,
                    description: eventData.description,
                    meetingUrl: eventData.meetingUrl,
                    startTime: eventData.startTime,
                    endTime: eventData.endTime,
                    attendees: eventData.attendees
                }
            })
            console.log(`🔄 Updated meeting: ${eventData.title}`)
        } else {
            await prisma.meeting.create({ data: eventData })
            console.log(`✨ Created meeting: ${eventData.title}`)
        }
    } catch (error) {
        console.error(`❌ Error processing event ${event.id}:`, error.message)
    }
}

async function scheduleBotsForUpcomingMeetings() {
    try {
        const now = new Date()
        const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000)

        const upcomingMeetings = await prisma.meeting.findMany({
            where: {
                startTime: {
                    gte: now,
                    lte: fiveMinutesFromNow
                },
                botScheduled: true,
                botSent: false,
                meetingUrl: { not: null },
                meetingEnded: false
            },
            include: { user: true }
        })

        console.log(`Found ${upcomingMeetings.length} meetings to schedule bots for`)

        for (const meeting of upcomingMeetings) {
            try {
                console.log(`\n🎯 Processing: "${meeting.title}" by ${meeting.user.email}`)

                const canSchedule = await canUserScheduleMeeting(meeting.user)
                
                if (!canSchedule.allowed) {
                    console.log(`❌ Cannot schedule bot: ${canSchedule.reason}`)
                    await prisma.meeting.update({
                        where: { id: meeting.id },
                        data: {
                            botSent: true,
                            botJoinedAt: new Date()
                        }
                    })
                    continue
                }

                console.log(`✅ User eligible. Deploying bot...`)

                const botResponse = await deployBotToMeeting(meeting)

                if (botResponse.success) {
                    await prisma.meeting.update({
                        where: { id: meeting.id },
                        data: {
                            botSent: true,
                            botId: botResponse.bot_id,
                            botJoinedAt: new Date()
                        }
                    })

                    await prisma.user.update({
                        where: { id: meeting.userId },
                        data: {
                            meetingsThisMonth: { increment: 1 }
                        }
                    })

                    console.log(`✅ Bot deployed! Bot ID: ${botResponse.bot_id}`)
                } else {
                    console.error(`❌ Failed to deploy bot: ${botResponse.error}`)
                }
            } catch (error) {
                console.error(`❌ Error scheduling bot for "${meeting.title}":`, error.message)
            }
        }
    } catch (error) {
        console.error('❌ Error in scheduleBotsForUpcomingMeetings:', error)
    }
}

async function deployBotToMeeting(meeting) {
    try {
        const requestBody = {
            meeting_url: meeting.meetingUrl,
            bot_name: meeting.user.botName || 'Meeting Bot',
            reserved: false,
            recording_mode: 'speaker_view',
            speech_to_text: { provider: 'Default' },
            webhook_url: process.env.WEBHOOK_URL,
            extra: {
                meeting_id: meeting.id,
                user_id: meeting.userId
            }
        }

        if (meeting.user.botImageUrl) {
            requestBody.bot_image = meeting.user.botImageUrl
        }

        console.log(`🔗 Calling MeetingBaas API...`)

        const response = await fetch('https://api.meetingbaas.com/bots', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-meeting-baas-api-key': process.env.MEETING_BAAS_API_KEY
            },
            body: JSON.stringify(requestBody)
        })

        if (!response.ok) {
            const error = await response.text()
            console.error(`MeetingBaas API error (${response.status}):`, error)
            return {
                success: false,
                error: `HTTP ${response.status}: ${error}`
            }
        }

        const data = await response.json()
        console.log(`✅ MeetingBaas response:`, data)

        return {
            success: true,
            bot_id: data.bot_id
        }
    } catch (error) {
        console.error('❌ Error deploying bot:', error)
        return {
            success: false,
            error: error.message
        }
    }
}

async function canUserScheduleMeeting(user) {
    try {
        const PLAN_LIMITS = {
            free: { meetings: 0 },
            starter: { meetings: 10 },
            pro: { meetings: 30 },
            premium: { meetings: -1 }
        }

        const limits = PLAN_LIMITS[user.currentPlan] || PLAN_LIMITS.free

        console.log(`📊 User plan: ${user.currentPlan}, Usage: ${user.meetingsThisMonth}/${limits.meetings}`)

        if (user.currentPlan === 'free') {
            return {
                allowed: false,
                reason: 'Free plan users cannot use bot feature'
            }
        }

        if (user.subscriptionStatus !== 'active') {
            return {
                allowed: false,
                reason: `Subscription is ${user.subscriptionStatus}`
            }
        }

        if (limits.meetings !== -1 && user.meetingsThisMonth >= limits.meetings) {
            return {
                allowed: false,
                reason: `Monthly limit reached (${user.meetingsThisMonth}/${limits.meetings})`
            }
        }

        return { 
            allowed: true,
            reason: 'User is eligible'
        }
    } catch (error) {
        console.error('❌ Error checking limits:', error)
        return { 
            allowed: false, 
            reason: 'Error checking limits' 
        }
    }
}

async function resetDailyChatUsage() {
    try {
        const result = await prisma.user.updateMany({
            where: { subscriptionStatus: 'active' },
            data: { chatMessagesToday: 0 }
        })

        console.log(`✅ Reset daily chat for ${result.count} active users`)
    } catch (error) {
        console.error('❌ Error resetting daily chat:', error)
    }
}