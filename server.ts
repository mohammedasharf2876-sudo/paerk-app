import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database("parking.db");

// Initialize Database
db.exec(`
  CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    full_name TEXT,
    role_id INTEGER,
    FOREIGN KEY (role_id) REFERENCES roles(id)
  );

  CREATE TABLE IF NOT EXISTS pricing_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_type TEXT UNIQUE NOT NULL, -- 'Car', 'Motorcycle'
    first_hour_price REAL DEFAULT 10,
    additional_hour_price REAL DEFAULT 5,
    daily_max_price REAL DEFAULT 50,
    grace_period_minutes INTEGER DEFAULT 15,
    min_charge REAL DEFAULT 10
  );

  CREATE TABLE IF NOT EXISTS parking_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plate_number TEXT NOT NULL,
    vehicle_type TEXT NOT NULL,
    ticket_number TEXT UNIQUE NOT NULL,
    entry_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    exit_time DATETIME,
    status TEXT DEFAULT 'Active', -- 'Active', 'Completed'
    total_amount REAL DEFAULT 0,
    payment_status TEXT DEFAULT 'Unpaid', -- 'Unpaid', 'Paid'
    vehicle_image TEXT
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plate_number TEXT UNIQUE NOT NULL,
    owner_name TEXT,
    owner_phone TEXT,
    type TEXT, -- 'Weekly', 'Monthly', 'Yearly'
    start_date DATE,
    end_date DATE,
    status TEXT DEFAULT 'Active',
    amount_paid REAL DEFAULT 0,
    notes TEXT,
    vehicle_type TEXT DEFAULT 'Car',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,
    details TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER,
    amount REAL,
    payment_method TEXT, -- 'Cash', 'Visa', 'Transfer'
    payment_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    user_id INTEGER,
    FOREIGN KEY (session_id) REFERENCES parking_sessions(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  -- Seed initial data
  INSERT OR IGNORE INTO roles (name) VALUES ('Admin'), ('Receptionist'), ('Cashier'), ('Supervisor');
  INSERT OR IGNORE INTO users (username, password, full_name, role_id) VALUES ('admin', 'admin123', 'مدير النظام', 1);
  INSERT OR IGNORE INTO pricing_rules (vehicle_type, first_hour_price, additional_hour_price, daily_max_price) VALUES ('Car', 10, 5, 100), ('Motorcycle', 5, 2, 50);
`);

// Migration: Add missing columns to subscriptions if they don't exist
const columns = db.prepare("PRAGMA table_info(subscriptions)").all();
const columnNames = (columns as any[]).map(c => c.name);

if (!columnNames.includes('amount_paid')) {
  try { db.exec("ALTER TABLE subscriptions ADD COLUMN amount_paid REAL DEFAULT 0"); } catch(e) {}
}
if (!columnNames.includes('notes')) {
  try { db.exec("ALTER TABLE subscriptions ADD COLUMN notes TEXT"); } catch(e) {}
}
if (!columnNames.includes('vehicle_type')) {
  try { db.exec("ALTER TABLE subscriptions ADD COLUMN vehicle_type TEXT DEFAULT 'Car'"); } catch(e) {}
}
if (!columnNames.includes('created_at')) {
  try { db.exec("ALTER TABLE subscriptions ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP"); } catch(e) {}
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Helper for Audit Logs
  const logAction = (user_id: number, action: string, details: string) => {
    try {
      db.prepare("INSERT INTO audit_logs (user_id, action, details) VALUES (?, ?, ?)").run(user_id, action, details);
    } catch (err) {
      console.error("Failed to log action", err);
    }
  };

  // API Routes
  
  // Dashboard Stats
  app.get("/api/stats", (req, res) => {
    const activeCars = db.prepare("SELECT COUNT(*) as count FROM parking_sessions WHERE status = 'Active'").get();
    const entriesToday = db.prepare("SELECT COUNT(*) as count FROM parking_sessions WHERE date(entry_time) = date('now')").get();
    const exitsToday = db.prepare("SELECT COUNT(*) as count FROM parking_sessions WHERE date(exit_time) = date('now')").get();
    const todayRevenue = db.prepare("SELECT SUM(amount) as total FROM payments WHERE date(payment_time) = date('now')").get();
    const activeSubs = db.prepare("SELECT COUNT(*) as count FROM subscriptions WHERE status = 'Active' AND end_date >= date('now')").get();
    const expiredSubs = db.prepare("SELECT COUNT(*) as count FROM subscriptions WHERE end_date < date('now')").get();
    const recentPayments = db.prepare("SELECT COUNT(*) as count FROM payments WHERE date(payment_time) = date('now')").get();
    
    const recentOperations = db.prepare(`
      SELECT 'Entry' as type, plate_number, entry_time as time, status FROM parking_sessions 
      UNION ALL
      SELECT 'Exit' as type, plate_number, exit_time as time, status FROM parking_sessions WHERE status = 'Completed'
      ORDER BY time DESC LIMIT 10
    `).all();

    res.json({
      activeCars: activeCars.count,
      entriesToday: entriesToday.count,
      exitsToday: exitsToday.count,
      todayRevenue: todayRevenue.total || 0,
      activeSubs: activeSubs.count,
      expiredSubs: expiredSubs.count,
      recentPayments: recentPayments.count,
      recentOperations
    });
  });

  // Entry
  app.post("/api/entry", (req, res) => {
    const { plate_number, vehicle_type, vehicle_image } = req.body;
    const ticket_number = "TKT-" + Date.now();
    
    const info = db.prepare("INSERT INTO parking_sessions (plate_number, vehicle_type, ticket_number, vehicle_image) VALUES (?, ?, ?, ?)").run(plate_number, vehicle_type, ticket_number, vehicle_image);
    
    logAction(1, 'Vehicle Entry', `Plate: ${plate_number}, Ticket: ${ticket_number}`);
    
    res.json({ id: info.lastInsertRowid, ticket_number });
  });

  // Exit Calculation
  app.get("/api/exit-calc/:query", (req, res) => {
    const query = req.params.query;
    const session = db.prepare(`
      SELECT * FROM parking_sessions 
      WHERE (ticket_number = ? OR plate_number = ?) 
      AND status = 'Active'
      ORDER BY entry_time DESC LIMIT 1
    `).get(query, query);
    
    if (!session) return res.status(404).json({ error: "لم يتم العثور على تذكرة أو سيارة نشطة بهذا الرقم" });
    
    const pricing = db.prepare("SELECT * FROM pricing_rules WHERE vehicle_type = ?").get(session.vehicle_type);
    
    const entryTime = new Date(session.entry_time);
    const exitTime = new Date();
    const durationMs = exitTime.getTime() - entryTime.getTime();
    const durationHours = Math.ceil(durationMs / (1000 * 60 * 60));
    
    let amount = 0;
    if (durationHours <= 1) {
      amount = pricing.first_hour_price;
    } else {
      amount = pricing.first_hour_price + (durationHours - 1) * pricing.additional_hour_price;
    }
    
    amount = Math.min(amount, pricing.daily_max_price);
    amount = Math.max(amount, pricing.min_charge);

    // Check for active subscription
    const sub = db.prepare("SELECT * FROM subscriptions WHERE plate_number = ? AND status = 'Active' AND end_date >= date('now')").get(session.plate_number);
    if (sub) {
      amount = 0; // Subscription covers it
    }

    res.json({ session, amount, durationHours, hasSubscription: !!sub, vehicle_image: session.vehicle_image });
  });

  // Complete Payment and Exit
  app.post("/api/payment", (req, res) => {
    const { session_id, amount, payment_method, user_id } = req.body;
    
    const transaction = db.transaction(() => {
      db.prepare("UPDATE parking_sessions SET exit_time = CURRENT_TIMESTAMP, status = 'Completed', total_amount = ?, payment_status = 'Paid' WHERE id = ?").run(amount, session_id);
      db.prepare("INSERT INTO payments (session_id, amount, payment_method, user_id) VALUES (?, ?, ?, ?)").run(session_id, amount, payment_method, user_id);
      
      logAction(user_id || 1, 'Payment & Exit', `Session ID: ${session_id}, Amount: ${amount}, Method: ${payment_method}`);
    });
    
    transaction();
    res.json({ success: true });
  });

  // Subscriptions CRUD
  app.get("/api/subscriptions", (req, res) => {
    const subs = db.prepare("SELECT * FROM subscriptions ORDER BY created_at DESC").all();
    res.json(subs);
  });

  app.post("/api/subscriptions", (req, res) => {
    const { plate_number, owner_name, owner_phone, type, start_date, end_date, amount_paid, notes, vehicle_type } = req.body;
    try {
      db.prepare(`
        INSERT INTO subscriptions (plate_number, owner_name, owner_phone, type, start_date, end_date, amount_paid, notes, vehicle_type) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(plate_number, owner_name, owner_phone, type, start_date, end_date, amount_paid, notes, vehicle_type || 'Car');
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put("/api/subscriptions/:id", (req, res) => {
    const { plate_number, owner_name, owner_phone, type, start_date, end_date, status, amount_paid, notes } = req.body;
    db.prepare(`
      UPDATE subscriptions 
      SET plate_number = ?, owner_name = ?, owner_phone = ?, type = ?, start_date = ?, end_date = ?, status = ?, amount_paid = ?, notes = ?
      WHERE id = ?
    `).run(plate_number, owner_name, owner_phone, type, start_date, end_date, status, amount_paid, notes, req.params.id);
    res.json({ success: true });
  });

  app.delete("/api/subscriptions/:id", (req, res) => {
    db.prepare("DELETE FROM subscriptions WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  });

  // Settings & Pricing
  app.get("/api/pricing", (req, res) => {
    const pricing = db.prepare("SELECT * FROM pricing_rules").all();
    res.json(pricing);
  });

  app.put("/api/pricing/:type", (req, res) => {
    const { first_hour_price, additional_hour_price, daily_max_price } = req.body;
    db.prepare(`
      UPDATE pricing_rules 
      SET first_hour_price = ?, additional_hour_price = ?, daily_max_price = ?
      WHERE vehicle_type = ?
    `).run(first_hour_price, additional_hour_price, daily_max_price, req.params.type);
    
    logAction(1, 'Update Pricing', `Type: ${req.params.type}, First: ${first_hour_price}, Extra: ${additional_hour_price}`);
    
    res.json({ success: true });
  });

  // Reports
  app.get("/api/reports/daily", (req, res) => {
    const report = db.prepare(`
      SELECT p.payment_time, p.amount, p.payment_method, s.plate_number, s.vehicle_type
      FROM payments p
      JOIN parking_sessions s ON p.session_id = s.id
      WHERE date(p.payment_time) = date('now')
    `).all();
    res.json(report);
  });

  app.get("/api/reports/audit", (req, res) => {
    const logs = db.prepare(`
      SELECT a.*, u.username 
      FROM audit_logs a
      LEFT JOIN users u ON a.user_id = u.id
      ORDER BY a.timestamp DESC LIMIT 100
    `).all();
    res.json(logs);
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
