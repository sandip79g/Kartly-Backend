require("dotenv").config();
const express = require("express");
const cors = require("cors");

require("./db"); // initializes + seeds the SQLite database on startup
const { initialize: initializeEmbeddingDatabase } = require("./db/embedding");

const authRoutes = require("./routes/auth");
const productRoutes = require("./routes/products");
const orderRoutes = require("./routes/orders");
const adminRoutes = require("./routes/admin");
const botRoutes = require("./routes/bot");
const ragRoutes = require("./routes/rag");

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

app.use("/api/auth", authRoutes);
app.use("/api/products", productRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/bot", botRoutes );
app.use("/api/rag", ragRoutes.router);

// 404 handler
app.use((req, res) => res.status(404).json({ message: "Not found." }));

// Error handler
app.use((err, req, res, next) => {
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ message: "Uploaded image is too large. Please choose a smaller file." });
  }
  console.error(err);
  res.status(500).json({ message: "Internal server error." });
});

const PORT = process.env.PORT || 5000;

async function startServer() {
  await initializeEmbeddingDatabase();

  app.listen(PORT, () => {
    console.log(`API server running on http://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("API server startup failed:", error);
  process.exitCode = 1;
});
