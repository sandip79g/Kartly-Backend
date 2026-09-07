const postgres = require("pg");
const pgvector = require("pgvector/pg");

const { Pool } = postgres;

const embeddingDatabase = new Pool({
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || "ecommerce_user",
    password: process.env.PGPASSWORD || "ecommerce_pass",
    database: process.env.PGDATABASE || "shop_db",
    connectionTimeoutMillis: 5000,
});

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function initialize({ retries = 10, retryDelayMs = 2000 } = {}) {
    for (let attempt = 1; attempt <= retries; attempt += 1) {
        let client;

        try {
            client = await embeddingDatabase.connect();
            console.log("Initializing embedding database...");

            await client.query(`
                CREATE EXTENSION IF NOT EXISTS vector;
            `);

            await pgvector.registerTypes(client);

            await client.query(`
                CREATE TABLE IF NOT EXISTS knowledge_chunks (
                    id SERIAL PRIMARY KEY,
                    source_type VARCHAR(255) NOT NULL,
                    source_id VARCHAR(255),
                    content TEXT NOT NULL,
                    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                    embedding HALFVEC(768) NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
            `);

            await client.query(`
                CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx
                ON knowledge_chunks
                USING hnsw (embedding halfvec_cosine_ops);
            `);

            console.log("Embedding database initialized");
            return;
        } catch (error) {
            if (attempt === retries) {
                console.error("Embedding database initialization failed:");
                throw error;
            }

            console.warn(
                `Embedding database is not ready (attempt ${attempt}/${retries}). Retrying in ${retryDelayMs}ms...`,
            );
            await wait(retryDelayMs);
        } finally {
            client?.release();
        }
    }
}

embeddingDatabase.initialize = initialize;

module.exports = {
    embeddingDatabase,
    initialize,
};