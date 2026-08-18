require("dotenv").config();
const path = require("path");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");

const dbPath = path.join(__dirname, "shop.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ---------- Schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  full_name TEXT,
  avatar_url TEXT,
  password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  price REAL NOT NULL,
  image TEXT,
  category_id INTEGER,
  stock INTEGER NOT NULL DEFAULT 0,
  rating REAL DEFAULT 4.5,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  total REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','shipped','delivered','cancelled')),
  payment_method TEXT,
  payment_status TEXT NOT NULL DEFAULT 'paid' CHECK(payment_status IN ('paid','pending','failed','refunded')),
  payment_reference TEXT,
  payment_details TEXT,
  address TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  price REAL NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  comment TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, product_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chat_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  message TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
}

ensureColumn("products", "discount_percent", "REAL NOT NULL DEFAULT 0");
ensureColumn("products", "images", "TEXT NOT NULL DEFAULT ''");
ensureColumn("users", "full_name", "TEXT");
ensureColumn("users", "avatar_url", "TEXT");
ensureColumn("orders", "payment_method", "TEXT");
ensureColumn("orders", "payment_status", "TEXT NOT NULL DEFAULT 'paid'");
ensureColumn("orders", "payment_reference", "TEXT");
ensureColumn("orders", "payment_details", "TEXT");

const reviewColumns = db.prepare("PRAGMA table_info(reviews)").all();
if (reviewColumns.length > 0 && !reviewColumns.some((item) => item.name === "updated_at")) {
  db.prepare("ALTER TABLE reviews ADD COLUMN updated_at TEXT DEFAULT CURRENT_TIMESTAMP").run();
}

// ---------- Seed: admin account ----------
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "suadmin";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@shopprotype.com";

const existingAdmin = db
  .prepare("SELECT id FROM users WHERE username = ?")
  .get(ADMIN_USERNAME);

if (!existingAdmin) {
  const hashed = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  db.prepare(
    "INSERT INTO users (username, email, full_name, avatar_url, password, role) VALUES (?, ?, ?, ?, ?, 'admin')"
  ).run(
    ADMIN_USERNAME,
    ADMIN_EMAIL,
    "Kartly Admin",
    `https://ui-avatars.com/api/?name=${encodeURIComponent(ADMIN_USERNAME)}&background=0F172A&color=FFFFFF&bold=true`,
    hashed
  );
  console.log(`Seeded admin account -> username: ${ADMIN_USERNAME}`);
}

// ---------- Seed: categories + sample products ----------
const categoryCount = db.prepare("SELECT COUNT(*) AS c FROM categories").get().c;

if (categoryCount === 0) {
  const categories = ["Electronics", "Fashion", "Home & Kitchen", "Books", "Sports & Outdoors"];
  const insertCategory = db.prepare("INSERT INTO categories (name) VALUES (?)");
  const categoryIds = {};
  categories.forEach((name) => {
    const info = insertCategory.run(name);
    categoryIds[name] = info.lastInsertRowid;
  });

  const products = [
    ["Wireless Noise-Cancelling Headphones", "Over-ear Bluetooth headphones with 30-hour battery life and active noise cancellation.", 89.99, "Electronics", 42, 4.6],
    ["Smart Fitness Watch", "Track heart rate, sleep, and workouts with a 7-day battery and AMOLED display.", 59.99, "Electronics", 30, 4.3],
    ["Portable Bluetooth Speaker", "Waterproof speaker with 360-degree sound and 12-hour playtime.", 34.5, "Electronics", 65, 4.4],
    ["Mechanical Keyboard RGB", "Hot-swappable mechanical keyboard with per-key RGB lighting.", 74.0, "Electronics", 20, 4.7],
    ["Men's Classic Fit Denim Jacket", "Durable cotton denim jacket for everyday wear.", 45.0, "Fashion", 50, 4.2],
    ["Women's Running Shoes", "Lightweight breathable running shoes with cushioned sole.", 52.99, "Fashion", 38, 4.5],
    ["Unisex Canvas Backpack", "Water-resistant 20L backpack with laptop compartment.", 29.99, "Fashion", 70, 4.1],
    ["Polarized Sunglasses", "UV400 protection with a lightweight polycarbonate frame.", 19.99, "Fashion", 90, 4.0],
    ["Stainless Steel Cookware Set", "10-piece cookware set, dishwasher safe and induction ready.", 129.99, "Home & Kitchen", 15, 4.6],
    ["Electric Kettle 1.7L", "Rapid boil electric kettle with auto shut-off.", 24.99, "Home & Kitchen", 40, 4.3],
    ["Memory Foam Pillow (2-Pack)", "Ergonomic cervical support pillow for side and back sleepers.", 32.5, "Home & Kitchen", 55, 4.4],
    ["Robot Vacuum Cleaner", "Smart mapping robot vacuum with app control and auto-recharge.", 189.0, "Home & Kitchen", 12, 4.5],
    ["Atomic Habits - Paperback", "A practical guide to building good habits and breaking bad ones.", 14.99, "Books", 100, 4.8],
    ["The Pragmatic Programmer", "Classic guide to becoming a better software developer.", 27.99, "Books", 45, 4.7],
    ["Sketchbook - Hardcover A4", "160gsm acid-free paper, 100 sheets, perfect for sketching.", 9.99, "Books", 80, 4.2],
    ["Yoga Mat with Carry Strap", "Non-slip 6mm eco-friendly yoga mat.", 22.0, "Sports & Outdoors", 60, 4.4],
    ["Adjustable Dumbbell Set", "5-52.5 lb adjustable dumbbells, space-saving design.", 249.0, "Sports & Outdoors", 8, 4.6],
    ["Camping Tent 4-Person", "Waterproof dome tent, easy 10-minute setup.", 79.99, "Sports & Outdoors", 18, 4.3],
    ["Insulated Water Bottle 1L", "Keeps drinks cold for 24h and hot for 12h.", 17.5, "Sports & Outdoors", 100, 4.5],
    ["Resistance Bands Set", "5 latex resistance bands for strength training.", 15.99, "Sports & Outdoors", 75, 4.1],
  ];

  const insertProduct = db.prepare(
    `INSERT INTO products (title, description, price, category_id, stock, rating, image, images, discount_percent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  products.forEach(([title, description, price, category, stock, rating]) => {
    const seed = encodeURIComponent(title.split(" ").slice(0, 3).join(" "));
    const image = `https://picsum.photos/seed/${seed}/600/600`;
    insertProduct.run(title, description, price, categoryIds[category], stock, rating, image, image, 0);
  });

  console.log(`Seeded ${products.length} sample products across ${categories.length} categories.`);
}

module.exports = db;
