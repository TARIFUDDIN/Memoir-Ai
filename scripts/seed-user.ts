import { prisma } from "../lib/db"

async function main ()
{
    const user = await prisma.user.upsert( {
        where: { clerkId: "user_3DWU18qpQB4p1kzWB4qzDqzCgOU" },
        update: {},
        create: {
            clerkId: "user_3DWU18qpQB4p1kzWB4qzDqzCgOU",
            email: "rafiuddin.tarif@gmail.com",
            name: "Tarif",
            calendarConnected: false,
        },
    } )
    console.log( "✅ User created:", user )
    await prisma.$disconnect()
}

main().catch( console.error )