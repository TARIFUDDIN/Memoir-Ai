import { Pinecone } from '@pinecone-database/pinecone'

function getIndex ()
{
    if ( !process.env.PINECONE_API_KEY ) throw new Error( "PINECONE_API_KEY is missing in .env" )
    if ( !process.env.PINECONE_INDEX_NAME ) throw new Error( "PINECONE_INDEX_NAME is missing in .env" )
    const pinecone = new Pinecone( { apiKey: process.env.PINECONE_API_KEY } )
    return pinecone.index( process.env.PINECONE_INDEX_NAME )
}

// Pinecone rejects null/undefined metadata values — replace with empty string
function sanitizeMetadata ( metadata: Record<string, any> ): Record<string, string | number | boolean | string[]>
{
    return Object.fromEntries(
        Object.entries( metadata ).map( ( [ key, val ] ) => [
            key,
            val === null || val === undefined ? "" : val
        ] )
    )
}

export async function saveManyVectors ( vectors: Array<{
    id: string
    embedding: number[]
    metadata: any
}> )
{
    const index = getIndex()

    const valid = vectors.filter( v => Array.isArray( v.embedding ) && v.embedding.length > 0 )

    if ( valid.length === 0 )
    {
        console.warn( "⚠️ saveManyVectors: no valid vectors to upsert" )
        return
    }
    if ( valid.length < vectors.length )
    {
        console.warn( `⚠️ Dropped ${ vectors.length - valid.length } vectors with empty embeddings` )
    }

    const BATCH_SIZE = 100
    for ( let i = 0; i < valid.length; i += BATCH_SIZE )
    {
        const batch = valid.slice( i, i + BATCH_SIZE )
        await index.upsert( batch.map( v => ( {
            id: v.id,
            values: v.embedding,
            metadata: sanitizeMetadata( v.metadata ),  // ✅ no nulls
        } ) ) )
        console.log( `✅ Pinecone upserted batch ${ Math.floor( i / BATCH_SIZE ) + 1 }: ${ batch.length } vectors` )
    }
}

export async function searchVectors (
    embedding: number[],
    filter: any = {},
    topK: number = 5
)
{
    const index = getIndex()
    const result = await index.query( {
        vector: embedding,
        filter,
        topK,
        includeMetadata: true
    } )
    return result.matches || []
}