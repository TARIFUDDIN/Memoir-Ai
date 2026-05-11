import Groq from "groq-sdk"

const groq = new Groq( { apiKey: process.env.GROQ_API_KEY! } )

const COHERE_BATCH_SIZE = 90 // safely under the 96 limit

export async function createEmbedding ( text: string ): Promise<number[]>
{
    const embeddings = await createManyEmbeddings( [ text ] )
    return embeddings[ 0 ] || []
}

export async function createManyEmbeddings ( texts: string[] ): Promise<number[][]>
{
    if ( texts.length === 0 ) return []

    // Split into batches of 90 to stay under Cohere's 96-text limit
    const batches: string[][] = []
    for ( let i = 0; i < texts.length; i += COHERE_BATCH_SIZE )
    {
        batches.push( texts.slice( i, i + COHERE_BATCH_SIZE ) )
    }

    const allEmbeddings: number[][] = []

    for ( let i = 0; i < batches.length; i++ )
    {
        const batch = batches[ i ]
        console.log( `🔢 Embedding batch ${ i + 1 }/${ batches.length } (${ batch.length } texts)` )

        const response = await fetch( "https://api.cohere.com/v2/embed", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${ process.env.COHERE_API_KEY }`
            },
            body: JSON.stringify( {
                texts: batch,
                model: "embed-english-light-v3.0",
                input_type: "search_document",
                embedding_types: [ "float" ]
            } )
        } )

        if ( !response.ok )
        {
            const err = await response.text()
            console.error( `❌ Cohere batch ${ i + 1 } failed:`, err )
            // Push empty embeddings for this batch so indices stay aligned
            allEmbeddings.push( ...batch.map( () => [] ) )
            continue
        }

        const data = await response.json()
        const batchEmbeddings: number[][] = data?.embeddings?.float || []

        if ( batchEmbeddings.length !== batch.length )
        {
            console.warn( `⚠️ Cohere returned ${ batchEmbeddings.length } embeddings for ${ batch.length } texts` )
        }

        allEmbeddings.push( ...batchEmbeddings )
    }

    return allEmbeddings
}

export async function chatWithAI ( systemPrompt: string, userQuestion: string ): Promise<string>
{
    const response = await groq.chat.completions.create( {
        model: "llama-3.3-70b-versatile",
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userQuestion }
        ],
        temperature: 0.7,
        max_tokens: 500,
    } )
    return response.choices[ 0 ]?.message?.content || "Sorry, I could not generate a response."
}