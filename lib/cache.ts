import { Redis } from "@upstash/redis"

let redis: Redis | null = null;
try
{
    if ( process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN )
    {
        redis = Redis.fromEnv()
    }
} catch ( e )
{
    console.warn( "Redis env missing" )
}

// Probe once per process — if unreachable, skip all Redis calls silently
let redisAvailable: boolean | null = null

async function isRedisReachable (): Promise<boolean>
{
    if ( redisAvailable !== null ) return redisAvailable
    if ( !redis )
    {
        redisAvailable = false;
        return false;
    }
    try
    {
        await redis.ping()
        redisAvailable = true
        console.log( "✅ Redis connected" )
    } catch
    {
        redisAvailable = false
        console.warn( "⚠️ Redis unreachable — caching disabled for this session" )
    }
    return redisAvailable
}

export async function getCachedResponse ( prompt: string, userId: string )
{
    if ( !( await isRedisReachable() ) ) return null
    try
    {
        const sanitizedPrompt = prompt.trim().toLowerCase()
        const key = `cache:${ userId }:${ Buffer.from( sanitizedPrompt ).toString( 'base64' ) }`
        const cached = await redis?.get( key )
        return cached as string | null
    } catch ( error )
    {
        console.error( "Cache Read Failed", error )
        return null
    }
}

export async function setCachedResponse ( prompt: string, response: string, userId: string )
{
    if ( !( await isRedisReachable() ) ) return
    try
    {
        const sanitizedPrompt = prompt.trim().toLowerCase()
        const key = `cache:${ userId }:${ Buffer.from( sanitizedPrompt ).toString( 'base64' ) }`
        await redis?.set( key, response, { ex: 3600 } )
    } catch ( error )
    {
        console.error( "Cache Set Failed", error )
    }
}