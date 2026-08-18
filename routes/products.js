const express = require("express");
const db = require("../db");
const { authenticate, requireAdmin } = require("../middleware/auth");

const router = express.Router();

function normalizeImages(images, fallbackImage = "") {
  if (!images) return fallbackImage ? [fallbackImage] : [];
  if (Array.isArray(images)) return images.filter(Boolean);
  return String(images)
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseProductRow(product) {
  if (!product) return product;
  const images = normalizeImages(product.images, product.image);
  return {
    ...product,
    images,
    image: product.image || images[0] || "",
    discount_percent: Number(product.discount_percent || 0),
    discounted_price:
      product.discount_percent && Number(product.discount_percent) > 0
        ? Number((product.price * (1 - product.discount_percent / 100)).toFixed(2))
        : Number(product.price),
  };
}

function attachReviewStats(product) {
  const stats = db
    .prepare(
      `SELECT COUNT(*) AS review_count, COALESCE(AVG(rating), 0) AS average_rating
       FROM reviews
       WHERE product_id = ?`
    )
    .get(product.id);
  const rating = Number(stats.review_count > 0 ? Number(stats.average_rating).toFixed(1) : product.rating || 0);
  return {
    ...product,
    review_count: stats.review_count,
    rating,
  };
}

// GET /api/products?category=&search=&sort=
router.get("/", (req, res) => {
  const { category, search, sort } = req.query;
  let query = `
    SELECT p.*, c.name AS category
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE 1=1
  `;
  const params = [];

  if (category) {
    query += " AND c.name = ?";
    params.push(category);
  }
  if (search) {
    query += " AND (p.title LIKE ? OR p.description LIKE ?)";
    params.push(`%${search}%`, `%${search}%`);
  }

  const sortMap = {
    price_asc: "p.price ASC",
    price_desc: "p.price DESC",
    rating: "p.rating DESC",
    newest: "p.created_at DESC",
  };
  query += ` ORDER BY ${sortMap[sort] || "p.created_at DESC"}`;

  const products = db.prepare(query).all(...params).map((product) => parseProductRow(attachReviewStats(product)));
  res.json({ products });
});

// GET /api/products/categories
router.get("/categories", (req, res) => {
  const categories = db.prepare("SELECT * FROM categories ORDER BY name").all();
  res.json({ categories });
});

// GET /api/products/:id
router.get("/:id", (req, res) => {
  const product = db
    .prepare(
      `SELECT p.*, c.name AS category FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.id = ?`
    )
    .get(req.params.id);
  if (!product) return res.status(404).json({ message: "Product not found." });
  const reviewStats = db
    .prepare(
      `SELECT COUNT(*) AS review_count, COALESCE(AVG(rating), 0) AS average_rating
       FROM reviews
       WHERE product_id = ?`
    )
    .get(req.params.id);
  const reviewRows = db
    .prepare(
      `SELECT r.id, r.user_id, r.rating, r.comment, r.created_at, r.updated_at, u.username
       FROM reviews r
       JOIN users u ON u.id = r.user_id
       WHERE r.product_id = ?
       ORDER BY r.created_at DESC`
    )
    .all(req.params.id);
  const currentRating = Number(reviewStats.review_count > 0 ? Number(reviewStats.average_rating).toFixed(1) : product.rating || 0);
  res.json({
    product: {
      ...parseProductRow({
        ...attachReviewStats(product),
        rating: currentRating,
      }),
      review_count: reviewStats.review_count,
      reviews: reviewRows,
    },
  });
});

// GET /api/products/:id/reviews
router.get("/:id/reviews", (req, res) => {
  const product = db.prepare("SELECT id FROM products WHERE id = ?").get(req.params.id);
  if (!product) return res.status(404).json({ message: "Product not found." });

  const reviews = db
    .prepare(
      `SELECT r.id, r.user_id, r.rating, r.comment, r.created_at, r.updated_at, u.username
       FROM reviews r
       JOIN users u ON u.id = r.user_id
       WHERE r.product_id = ?
       ORDER BY r.created_at DESC`
    )
    .all(req.params.id);
  const stats = db
    .prepare(
      `SELECT COUNT(*) AS review_count, COALESCE(AVG(rating), 0) AS average_rating
       FROM reviews
       WHERE product_id = ?`
    )
    .get(req.params.id);

  res.json({
    reviews,
    review_count: stats.review_count,
    average_rating: Number(stats.review_count > 0 ? Number(stats.average_rating).toFixed(1) : 0),
  });
});

// POST /api/products/:id/reviews
router.post("/:id/reviews", authenticate, (req, res) => {
  const { rating, comment } = req.body;
  const numericRating = Number(rating);
  if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
    return res.status(400).json({ message: "Rating must be between 1 and 5." });
  }
  if (!comment || !String(comment).trim()) {
    return res.status(400).json({ message: "Review comment is required." });
  }

  const product = db.prepare("SELECT id FROM products WHERE id = ?").get(req.params.id);
  if (!product) return res.status(404).json({ message: "Product not found." });

  const existing = db
    .prepare("SELECT id FROM reviews WHERE user_id = ? AND product_id = ?")
    .get(req.user.id, req.params.id);

  if (existing) {
    db.prepare(
      `UPDATE reviews
       SET rating = ?, comment = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(numericRating, comment.trim(), existing.id);
  } else {
    db.prepare(
      `INSERT INTO reviews (user_id, product_id, rating, comment)
       VALUES (?, ?, ?, ?)`
    ).run(req.user.id, req.params.id, numericRating, comment.trim());
  }

  const review = db
    .prepare(
      `SELECT r.id, r.user_id, r.rating, r.comment, r.created_at, r.updated_at, u.username
       FROM reviews r
       JOIN users u ON u.id = r.user_id
       WHERE r.user_id = ? AND r.product_id = ?`
    )
    .get(req.user.id, req.params.id);

  res.status(existing ? 200 : 201).json({ review });
});

// DELETE /api/products/:id/reviews
router.delete("/:id/reviews", authenticate, (req, res) => {
  const review = db
    .prepare("SELECT id, user_id FROM reviews WHERE user_id = ? AND product_id = ?")
    .get(req.user.id, req.params.id);

  if (!review) {
    return res.status(404).json({ message: "Review not found." });
  }

  db.prepare("DELETE FROM reviews WHERE id = ?").run(review.id);
  res.json({ message: "Review deleted." });
});

// ---- Admin-only management ----

// POST /api/products
router.post("/", authenticate, requireAdmin, (req, res) => {
  const { title, description, price, image, images, category_id, stock, rating, discount_percent } = req.body;
  if (!title || price == null) {
    return res.status(400).json({ message: "Title and price are required." });
  }
  const normalizedImages = normalizeImages(images, image);
  const primaryImage = image || normalizedImages[0] || "";
  const info = db
    .prepare(
      `INSERT INTO products (title, description, price, image, images, category_id, stock, rating, discount_percent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      title,
      description || "",
      price,
      primaryImage,
      normalizedImages.join("\n"),
      category_id || null,
      stock || 0,
      rating || 4.5,
      discount_percent || 0
    );
  const product = db.prepare("SELECT * FROM products WHERE id = ?").get(info.lastInsertRowid);
  res.status(201).json({ product: parseProductRow(product) });
});

// PUT /api/products/:id
router.put("/:id", authenticate, requireAdmin, (req, res) => {
  const existing = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ message: "Product not found." });

  const merged = { ...existing, ...req.body };
  const normalizedImages = normalizeImages(merged.images, merged.image);
  const primaryImage = merged.image || normalizedImages[0] || "";
  db.prepare(
    `UPDATE products SET title=?, description=?, price=?, image=?, images=?, category_id=?, stock=?, rating=?, discount_percent=?
     WHERE id=?`
  ).run(
    merged.title,
    merged.description,
    merged.price,
    primaryImage,
    normalizedImages.join("\n"),
    merged.category_id,
    merged.stock,
    merged.rating,
    merged.discount_percent || 0,
    req.params.id
  );
  const product = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  res.json({ product: parseProductRow(product) });
});

// DELETE /api/products/:id
router.delete("/:id", authenticate, requireAdmin, (req, res) => {
  const existing = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ message: "Product not found." });
  db.prepare("DELETE FROM products WHERE id = ?").run(req.params.id);
  res.json({ message: "Product deleted." });
});

module.exports = router;
