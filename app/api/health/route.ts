import { prisma } from "@/lib/db"
import { NextResponse } from "next/server"

export async function GET ()
{
    const start = Date.now()
    try
    {
        await prisma.$queryRaw`SELECT 1`
        return NextResponse.json( {
            status: "ok",
            db: "reachable",
            latency_ms: Date.now() - start,
            timestamp: new Date().toISOString(),
        } )
    } catch ( error )
    {
        return NextResponse.json( {
            status: "error",
            db: "unreachable",
            latency_ms: Date.now() - start,
            timestamp: new Date().toISOString(),
        }, { status: 503 } )
    }
}