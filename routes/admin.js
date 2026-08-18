const express = require("express");
const db = require("../db");
const { authenticate, requireAdmin } = require("../middleware/auth");

const router = express.Router();

router.use(authenticate, requireAdmin);

// GET /api/admin/users
router.get("/users", (req, res) => {
  const users = db
    .prepare("SELECT id, username, email, full_name, avatar_url, role, created_at FROM users ORDER BY created_at DESC")
    .all();
  res.json({ users });
});

router.patch("/users/:id/role", (req, res) => {
  const { role } = req.body;
  if (!["user", "admin"].includes(role)) {
    return res.status(400).json({ message: "Invalid role." });
  }

  const user = db.prepare("SELECT id, username, role FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ message: "User not found." });
  if (user.username === process.env.ADMIN_USERNAME && role !== "admin") {
    return res.status(400).json({ message: "Primary admin role cannot be removed." });
  }

  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, req.params.id);
  const updated = db
    .prepare("SELECT id, username, email, full_name, avatar_url, role, created_at FROM users WHERE id = ?")
    .get(req.params.id);
  res.json({ user: updated });
});

router.delete("/users/:id", (req, res) => {
  const user = db.prepare("SELECT id, username, role FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ message: "User not found." });
  if (user.username === process.env.ADMIN_USERNAME) {
    return res.status(400).json({ message: "Primary admin account cannot be deleted." });
  }

  db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
  res.json({ message: "User deleted." });
});

// GET /api/admin/stats
router.get("/stats", (req, res) => {
  const userCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'user'").get().c;
  const productCount = db.prepare("SELECT COUNT(*) AS c FROM products").get().c;
  const orderCount = db.prepare("SELECT COUNT(*) AS c FROM orders").get().c;
  const revenue = db.prepare("SELECT COALESCE(SUM(total), 0) AS r FROM orders WHERE status != 'cancelled'").get().r;
  res.json({ userCount, productCount, orderCount, revenue });
});

router.get("/sales", (req, res) => {
  const totalRevenue = db
    .prepare("SELECT COALESCE(SUM(total), 0) AS total FROM orders WHERE status != 'cancelled'")
    .get().total;
  const paidRevenue = db
    .prepare("SELECT COALESCE(SUM(total), 0) AS total FROM orders WHERE status != 'cancelled' AND payment_status = 'paid'")
    .get().total;
  const totalSoldItems = db
    .prepare(
      `SELECT COALESCE(SUM(oi.quantity), 0) AS total
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.status != 'cancelled'`
    )
    .get().total;
  const paidOrders = db
    .prepare("SELECT COUNT(*) AS total FROM orders WHERE status != 'cancelled' AND payment_status = 'paid'")
    .get().total;
  const paymentBreakdown = db
    .prepare(
      `SELECT COALESCE(payment_method, 'unknown') AS payment_method,
              COUNT(*) AS count,
              COALESCE(SUM(total), 0) AS revenue
       FROM orders
       WHERE status != 'cancelled'
       GROUP BY payment_method
       ORDER BY revenue DESC`
    )
    .all();
  const topProducts = db
    .prepare(
      `SELECT oi.product_id, p.title, SUM(oi.quantity) AS quantity, SUM(oi.quantity * oi.price) AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN products p ON p.id = oi.product_id
       WHERE o.status != 'cancelled'
       GROUP BY oi.product_id
       ORDER BY quantity DESC, revenue DESC
       LIMIT 8`
    )
    .all();

  const monthlySoldItems = db
    .prepare(
      `SELECT strftime('%Y', o.created_at) AS year,
              strftime('%m', o.created_at) AS month,
              strftime('%m', o.created_at) AS month_number,
              COALESCE(SUM(oi.quantity), 0) AS quantity,
              COALESCE(SUM(oi.quantity * oi.price), 0) AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.status != 'cancelled'
       GROUP BY strftime('%Y', o.created_at), strftime('%m', o.created_at)
       ORDER BY year ASC, month_number ASC`
    )
    .all();

  const recentOrders = db
    .prepare(
      `SELECT o.id, o.status, o.total, o.payment_method, o.payment_status, o.created_at,
              u.username, u.full_name
       FROM orders o
       JOIN users u ON u.id = o.user_id
       WHERE o.status != 'cancelled'
       ORDER BY o.created_at DESC
       LIMIT 10`
    )
    .all();

  const dailyRows = db
    .prepare(
      `SELECT DATE(created_at) AS day, COALESCE(SUM(total), 0) AS revenue, COUNT(*) AS order_count
       FROM orders
       WHERE status != 'cancelled'
       GROUP BY DATE(created_at)
       ORDER BY DATE(created_at) ASC`
    )
    .all();

  const lastDays = 14;
  const dayMap = new Map(dailyRows.map((row) => [row.day, row]));
  const dailyRevenue = [];

  for (let offset = lastDays - 1; offset >= 0; offset -= 1) {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    const key = date.toISOString().slice(0, 10);
    const row = dayMap.get(key);
    dailyRevenue.push({
      day: key,
      revenue: Number((row?.revenue || 0).toFixed(2)),
      order_count: Number(row?.order_count || 0),
    });
  }

  res.json({
    totalRevenue,
    paidRevenue,
    totalSoldItems,
    paidOrders,
    paymentBreakdown,
    topProducts,
    dailyRevenue,
    monthlySoldItems,
    recentOrders,
  });
});

router.get("/reviews", (req, res) => {
  const reviews = db
    .prepare(
      `SELECT r.id, r.rating, r.comment, r.created_at, r.updated_at,
              u.username, u.email,
              p.id AS product_id, p.title AS product_title, p.image AS product_image
       FROM reviews r
       JOIN users u ON u.id = r.user_id
       JOIN products p ON p.id = r.product_id
       ORDER BY r.created_at DESC`
    )
    .all();
  res.json({ reviews });
});

router.delete("/reviews/:id", (req, res) => {
  const review = db.prepare("SELECT id FROM reviews WHERE id = ?").get(req.params.id);
  if (!review) return res.status(404).json({ message: "Review not found." });

  db.prepare("DELETE FROM reviews WHERE id = ?").run(req.params.id);
  res.json({ message: "Review deleted." });
});

module.exports = router;
