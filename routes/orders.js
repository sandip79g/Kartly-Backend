const express = require("express");
const db = require("../db");
const { authenticate, requireAdmin } = require("../middleware/auth");

const router = express.Router();

const allowedPaymentMethods = ["card", "paypal", "cod", "apple_pay"];

function buildPaymentReference(method) {
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `FAKE-${String(method || "PAY").toUpperCase()}-${suffix}`;
}

// POST /api/orders  (checkout) - user only
router.post("/", authenticate, (req, res) => {
  const { items, address, payment_method, payment_details } = req.body; // items: [{ product_id, quantity }]
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "Cart is empty." });
  }

  if (!allowedPaymentMethods.includes(payment_method)) {
    return res.status(400).json({ message: "Please choose a valid payment method." });
  }

  const getProduct = db.prepare("SELECT * FROM products WHERE id = ?");
  const updateStock = db.prepare("UPDATE products SET stock = stock - ? WHERE id = ?");
  const insertOrder = db.prepare(
    "INSERT INTO orders (user_id, total, address, status, payment_method, payment_status, payment_reference, payment_details) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)"
  );
  const insertItem = db.prepare(
    "INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)"
  );

  const txn = db.transaction(() => {
    let total = 0;
    const resolvedItems = [];

    for (const item of items) {
      const product = getProduct.get(item.product_id);
      if (!product) throw new Error(`Product ${item.product_id} not found.`);
      if (product.stock < item.quantity) {
        throw new Error(`Not enough stock for "${product.title}".`);
      }
      total += product.price * item.quantity;
      resolvedItems.push({ product, quantity: item.quantity });
    }

    const paymentStatus = payment_method === "cod" ? "pending" : "paid";
    const paymentReference = buildPaymentReference(payment_method);
    const orderInfo = insertOrder.run(
      req.user.id,
      total,
      address || "",
      payment_method,
      paymentStatus,
      paymentReference,
      payment_details ? JSON.stringify(payment_details) : ""
    );
    resolvedItems.forEach(({ product, quantity }) => {
      insertItem.run(orderInfo.lastInsertRowid, product.id, quantity, product.price);
      updateStock.run(quantity, product.id);
    });

    return orderInfo.lastInsertRowid;
  });

  try {
    const orderId = txn();
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    res.status(201).json({ order });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// GET /api/orders/mine - user's own orders
router.get("/mine", authenticate, (req, res) => {
  const orders = db
    .prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC")
    .all(req.user.id);

  const itemsStmt = db.prepare(
    `SELECT oi.*, p.title, p.image FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ?`
  );
  const withItems = orders.map((o) => ({ ...o, items: itemsStmt.all(o.id) }));
  res.json({ orders: withItems });
});

// ---- Admin ----

// GET /api/orders - all orders
router.get("/", authenticate, requireAdmin, (req, res) => {
  const orders = db
    .prepare(
      `SELECT o.*, u.username, u.email FROM orders o
       JOIN users u ON u.id = o.user_id
       ORDER BY o.created_at DESC`
    )
    .all();
  const itemsStmt = db.prepare(
    `SELECT oi.*, p.title FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ?`
  );
  const withItems = orders.map((o) => ({ ...o, items: itemsStmt.all(o.id) }));
  res.json({ orders: withItems });
});

// PUT /api/orders/:id/status
router.put("/:id/status", authenticate, requireAdmin, (req, res) => {
  const { status } = req.body;
  const allowed = ["pending", "processing", "shipped", "delivered", "cancelled"];
  if (!allowed.includes(status)) {
    return res.status(400).json({ message: "Invalid status." });
  }
  const existing = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ message: "Order not found." });

  db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, req.params.id);
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  res.json({ order });
});

module.exports = router;
