const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db");
const { authenticate } = require("../middleware/auth");
const nodemailer = require("nodemailer");
const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "kartly-dev-secret";

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );
}
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: process.env.SMTP_PORT || 587,
  auth: {
    user: process.env.SMTP_USER || "sandeep.adhikari014@gmail.com",
    pass: process.env.SMTP_PASS || "trgd rlix vckk nzsp"
  }
});





function sanitize(user) {
  const { password, ...rest } = user;
  return rest;
}

function fallbackAvatar(username) {
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(username || "User")}&background=0EA5A8&color=FFFFFF&bold=true`;
}

// POST /api/auth/register
router.post("/register", (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ message: "Username, email, and password are required." });
  }
  if (password.length < 6) {
    return res.status(400).json({ message: "Password must be at least 6 characters." });
  }
  // Reserve the admin username so nobody can self-register as admin
  if (username.toLowerCase() === "admin") {
    return res.status(400).json({ message: "That username is reserved." });
  }

  const existing = db
    .prepare("SELECT id FROM users WHERE username = ? OR email = ?")
    .get(username, email);
  if (existing) {
    return res.status(409).json({ message: "Username or email already in use." });
  }

  const hashed = bcrypt.hashSync(password, 10);
  const avatarUrl = fallbackAvatar(username);
  const info = db
    .prepare("INSERT INTO users (username, email, avatar_url, password, role) VALUES (?, ?, ?, ?, 'user')")
    .run(username, email, avatarUrl, hashed);

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
  const token = signToken(user);

  transporter.sendMail({
    from: process.env.SMTP_USER || "sandeep.adhikari014@gmail.com",
    to: user.email,
    subject: "Welcome to Kartly",
    html: `<p>Hello ${user.username},</p><p>Welcome to Kartly! We're excited to have you on board.</p>`
  });

  res.status(201).json({ token, user: sanitize(user) });
});

// POST /api/auth/login  (used for both users and admin)
router.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ message: "Username and password are required." });
  }

  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ message: "Invalid username or password." });
  }

  const token = signToken(user);
  res.json({ token, user: sanitize(user) });
});

// GET /api/auth/me
router.get("/me", authenticate, (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!user) return res.status(404).json({ message: "User not found." });
  res.json({ user: sanitize(user) });
});

// PUT /api/auth/me
router.put("/me", authenticate, (req, res) => {
  const { full_name, email, avatar_url } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!user) return res.status(404).json({ message: "User not found." });

  const nextEmail = String(email || "").trim();
  if (!nextEmail) {
    return res.status(400).json({ message: "Email is required." });
  }

  const existing = db
    .prepare("SELECT id FROM users WHERE email = ? AND id != ?")
    .get(nextEmail, req.user.id);
  if (existing) {
    return res.status(409).json({ message: "Email already in use." });
  }

  const nextAvatar = String(avatar_url || "").trim() || fallbackAvatar(user.username);
  db.prepare(
    `UPDATE users
     SET full_name = ?, email = ?, avatar_url = ?
     WHERE id = ?`
  ).run(String(full_name || "").trim() || null, nextEmail, nextAvatar, req.user.id);

  const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  res.json({ user: sanitize(updated) });
});

// PUT /api/auth/password
router.put("/password", authenticate, (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!user) return res.status(404).json({ message: "User not found." });

  if (!current_password || !new_password || !confirm_password) {
    return res.status(400).json({ message: "All password fields are required." });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ message: "New password must be at least 6 characters." });
  }
  if (new_password !== confirm_password) {
    return res.status(400).json({ message: "New passwords do not match." });
  }
  if (!bcrypt.compareSync(current_password, user.password)) {
    return res.status(400).json({ message: "Current password is incorrect." });
  }

  const hashed = bcrypt.hashSync(new_password, 10);
  db.prepare("UPDATE users SET password = ? WHERE id = ?").run(hashed, req.user.id);
  res.json({ message: "Password updated." });
});

module.exports = router;
