const express = require("express");
const { embeddingDatabase } = require("../db/embedding");
const { Ollama } = require("ollama");
const pgvector = require("pgvector/pg");

const ollama = new Ollama();

const router = express.Router();

async function generateEmbedding(text) {
    if (!text || typeof text !== "string") {
        throw new Error("Text is required to generate embedding.");
    }

    const response = await ollama.embed({
        model: "nomic-embed-text:latest",
        input: text.trim(),
    });

    const embedding = response.embeddings?.[0];

    if (!embedding) {
        throw new Error("Embedding model returned no embedding.");
    }

    return embedding;
}

/**
 * Search RAG knowledge base using semantic similarity.
 */
async function searchKnowledge({
    query,
    limit = 5,
    threshold = 0.5,
    sourceType = null,
}) {
    if (!query || typeof query !== "string") {
        throw new Error("Search query is required.");
    }

    const embedding = await generateEmbedding(query);

    const vector = pgvector.toSql(embedding);

    const params = [
        vector,
        Number(threshold),
        Number(limit),
    ];

    let sourceFilter = "";

    if (sourceType) {
        params.push(sourceType);
        sourceFilter = `AND source_type = $4`;
    }

    const result = await embeddingDatabase.query(
        `
        SELECT
            id,
            source_type,
            source_id,
            content,
            metadata,

            1 - (embedding <=> $1::halfvec) AS similarity

        FROM knowledge_chunks

        WHERE
            (embedding <=> $1::halfvec)
                <= (1.0 - $2::double precision)

            ${sourceFilter}

        ORDER BY embedding <=> $1::halfvec

        LIMIT $3::integer
        `,
        params
    );

    return result.rows.map((row) => ({
        ...row,
        similarity: Number(row.similarity),
    }));
}

/**
 * POST /api/embeddings
 *
 * {
 *   "content": "Customers may return products within...",
 *   "sourceType": "customer_support_policy",
 *   "sourceId": "customer-support-policy",
 *   "metadata": {
 *      "title": "Customer Support Policy",
 *      "section": "Returns"
 *   }
 * }
 */
router.post("/", async (req, res) => {
    try {
        const {
            content,
            sourceType = "document",
            sourceId = null,
            metadata = {},
        } = req.body;

        if (!content || typeof content !== "string") {
            return res.status(400).json({
                success: false,
                message: "Content is required.",
            });
        }

        const embedding = await generateEmbedding(content);

        console.log("Generated embedding:", embedding);

        const result = await embeddingDatabase.query(
            `
            INSERT INTO knowledge_chunks (source_type, source_id, content, metadata, embedding)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *`,
            [
                sourceType,
                sourceId,
                content,
                metadata,
                pgvector.toSql(embedding),
            ],
        );

        return res.status(201).json({
            success: true,
            message: "Embedding created successfully.",
            data: result.rows[0],
        });
    } catch (error) {
        console.error("Embedding error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to create embedding.",
            error: error.message,
        });
    }
});

module.exports = {
    generateEmbedding,
    router,
    searchKnowledge,
};