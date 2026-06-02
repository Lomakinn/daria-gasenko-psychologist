const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "app.sqlite");
const SEED_PATH = path.join(DATA_DIR, "seed.json");
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const PASSWORD_ITERATIONS = 310000;
const REQUEST_STATUSES = new Set(["new", "contacted", "intro", "paid", "rejected", "completed"]);
const LOGIN_LIMIT = { windowMs: 15 * 60 * 1000, max: 8 };
const API_LIMIT = { windowMs: 60 * 1000, max: 120 };
const rateBuckets = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon",
};

let db;

function now() {
  return new Date().toISOString();
}

function getClientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}

function securityHeaders(extra = {}) {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    ...extra,
  };
}

function jsonResponse(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, securityHeaders({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  }));
  res.end(JSON.stringify(payload));
}

function getCookie(req, name) {
  const cookies = req.headers.cookie || "";
  return cookies
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function cookieSecureFlag(req) {
  const isHttps = req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted;
  return isHttps || process.env.NODE_ENV === "production" ? "; Secure" : "";
}

function setSessionCookie(req, res, token) {
  res.setHeader("Set-Cookie", `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${cookieSecureFlag(req)}`);
}

function clearSessionCookie(req, res) {
  res.setHeader("Set-Cookie", `session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${cookieSecureFlag(req)}`);
}

function setCsrfCookie(req, res, token) {
  res.setHeader("Set-Cookie", `csrf=${token}; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${cookieSecureFlag(req)}`);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Request body is too large");
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function rateLimit(req, res, scope, config) {
  const key = `${scope}:${getClientIp(req)}`;
  const current = Date.now();
  const bucket = rateBuckets.get(key) || { count: 0, resetAt: current + config.windowMs };
  if (current > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = current + config.windowMs;
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (bucket.count > config.max) {
    jsonResponse(res, 429, { error: "Слишком много запросов. Попробуйте позже." });
    return false;
  }
  return true;
}

function validateCsrf(req, res) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
  const cookieToken = getCookie(req, "csrf");
  const headerToken = req.headers["x-csrf-token"];
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    jsonResponse(res, 403, { error: "CSRF token is missing or invalid" });
    return false;
  }
  return true;
}

function initDb() {
  require("node:fs").mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK(role IN ('admin','user')),
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_iterations INTEGER NOT NULL,
      password_algorithm TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      author TEXT NOT NULL,
      topic TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT,
      moderated_at TEXT,
      moderated_by TEXT
    );
    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY,
      tag TEXT NOT NULL,
      title TEXT NOT NULL,
      excerpt TEXT,
      href TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS consultation_requests (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      format TEXT,
      message TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      details TEXT,
      ip TEXT,
      created_at TEXT NOT NULL
    );
  `);
  seedIfNeeded();
}

function seedIfNeeded() {
  const existing = db.prepare("SELECT value FROM meta WHERE key = 'seeded'").get();
  if (existing) return;
  const seed = JSON.parse(require("node:fs").readFileSync(SEED_PATH, "utf8"));
  const insertUser = db.prepare(`INSERT INTO users (id, username, role, password_salt, password_hash, password_iterations, password_algorithm, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertReview = db.prepare(`INSERT INTO reviews (id, author, topic, text, status, created_at, moderated_at, moderated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertArticle = db.prepare(`INSERT INTO articles (id, tag, title, excerpt, href, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
  db.exec("BEGIN");
  try {
    for (const user of seed.users || []) {
      insertUser.run(user.id, user.username, user.role, user.passwordSalt, user.passwordHash, user.passwordIterations || 120000, user.passwordAlgorithm || "pbkdf2-sha256", user.createdAt);
    }
    for (const review of seed.reviews || []) {
      insertReview.run(review.id, review.author, review.topic, review.text, review.status, review.createdAt, review.moderatedAt || null, review.moderatedBy || null);
    }
    for (const article of seed.articles || []) {
      insertArticle.run(article.id, article.tag, article.title, article.excerpt || "", article.href, article.createdAt);
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('seeded', ?)").run(String(seed.schemaVersion || 1));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.created_at,
  };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return {
    salt,
    hash: crypto.pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 32, "sha256").toString("hex"),
    iterations: PASSWORD_ITERATIONS,
    algorithm: "pbkdf2-sha256",
  };
}

function verifyPassword(password, user) {
  const iterations = user.password_iterations || 120000;
  const hash = crypto.pbkdf2Sync(password, user.password_salt, iterations, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.password_hash, "hex"));
}

function validatePassword(password) {
  if (password.length < 10) return "Пароль должен быть минимум 10 символов.";
  if (!/[A-Za-zА-Яа-я]/.test(password) || !/[0-9]/.test(password)) return "Пароль должен содержать буквы и цифры.";
  return null;
}

function validateRole(role) {
  return role === "admin" || role === "user" ? role : "user";
}

function normalizeRequestStatus(status) {
  return REQUEST_STATUSES.has(status) ? status : "new";
}

function canAdmin(user) {
  return user?.role === "admin";
}

function canModerate(user) {
  return user?.role === "admin" || user?.role === "user";
}

function getCurrentUser(req) {
  const token = getCookie(req, "session");
  if (!token) return null;
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now());
  const session = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token);
  if (!session) return null;
  return db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id) || null;
}

function requireAuth(user, res) {
  if (!user) {
    jsonResponse(res, 401, { error: "Требуется вход" });
    return false;
  }
  return true;
}

function requireModerator(user, res) {
  if (!requireAuth(user, res)) return false;
  if (!canModerate(user)) {
    jsonResponse(res, 403, { error: "Недостаточно прав" });
    return false;
  }
  return true;
}

function requireAdmin(user, res) {
  if (!requireAuth(user, res)) return false;
  if (!canAdmin(user)) {
    jsonResponse(res, 403, { error: "Доступ только для администратора" });
    return false;
  }
  return true;
}

function audit(req, user, action, entityType, entityId, details = {}) {
  db.prepare("INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    crypto.randomUUID(),
    user?.id || null,
    action,
    entityType,
    entityId || null,
    JSON.stringify(details),
    getClientIp(req),
    now(),
  );
}

function reviewRow(row) {
  return {
    id: row.id,
    author: row.author,
    topic: row.topic,
    text: row.text,
    status: row.status,
    createdAt: row.created_at,
    moderatedAt: row.moderated_at || null,
    moderatedBy: row.moderated_by || null,
  };
}

function articleRow(row) {
  return {
    id: row.id,
    tag: row.tag,
    title: row.title,
    excerpt: row.excerpt,
    href: row.href,
    createdAt: row.created_at,
  };
}

function requestRow(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    format: row.format,
    message: row.message,
    status: normalizeRequestStatus(row.status),
    createdAt: row.created_at,
  };
}

async function handleApi(req, res, pathname) {
  if (!rateLimit(req, res, pathname === "/api/auth/login" ? "login" : "api", pathname === "/api/auth/login" ? LOGIN_LIMIT : API_LIMIT)) return;
  if (!validateCsrf(req, res)) return;
  const user = getCurrentUser(req);

  if (req.method === "GET" && pathname === "/api/csrf") {
    const token = crypto.randomBytes(24).toString("hex");
    setCsrfCookie(req, res, token);
    jsonResponse(res, 200, { csrfToken: token });
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/login") {
    const body = await readBody(req);
    const found = db.prepare("SELECT * FROM users WHERE username = ?").get(String(body.username || "").trim());
    if (!found || !verifyPassword(String(body.password || ""), found)) {
      audit(req, null, "login_failed", "user", null, { username: body.username || "" });
      jsonResponse(res, 401, { error: "Неверный логин или пароль" });
      return;
    }
    const token = crypto.randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(token, found.id, now(), new Date(Date.now() + SESSION_TTL_MS).toISOString());
    audit(req, found, "login", "user", found.id);
    setSessionCookie(req, res, token);
    jsonResponse(res, 200, { user: publicUser(found) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/logout") {
    const token = getCookie(req, "session");
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    audit(req, user, "logout", "user", user?.id);
    clearSessionCookie(req, res);
    jsonResponse(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/api/auth/me") {
    jsonResponse(res, 200, { user: user ? publicUser(user) : null });
    return;
  }

  if (req.method === "GET" && pathname === "/api/reviews") {
    jsonResponse(res, 200, { reviews: db.prepare("SELECT * FROM reviews WHERE status = 'approved' ORDER BY COALESCE(moderated_at, created_at) DESC").all().map(reviewRow) });
    return;
  }

  if (req.method === "GET" && pathname === "/api/articles") {
    jsonResponse(res, 200, { articles: db.prepare("SELECT * FROM articles ORDER BY created_at ASC").all().map(articleRow) });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/audit") {
    if (!requireAdmin(user, res)) return;
    jsonResponse(res, 200, { logs: db.prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200").all() });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/reviews") {
    if (!requireModerator(user, res)) return;
    jsonResponse(res, 200, { reviews: db.prepare("SELECT * FROM reviews ORDER BY created_at DESC").all().map(reviewRow) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/reviews") {
    if (!requireModerator(user, res)) return;
    const body = await readBody(req);
    const review = {
      id: crypto.randomUUID(),
      author: String(body.author || "").trim(),
      topic: String(body.topic || "Другое").trim(),
      text: String(body.text || "").trim(),
      createdAt: now(),
    };
    if (!review.author || !review.text) {
      jsonResponse(res, 400, { error: "Заполните автора и текст отзыва" });
      return;
    }
    db.prepare("INSERT INTO reviews (id, author, topic, text, status, created_at, created_by) VALUES (?, ?, ?, ?, 'pending', ?, ?)").run(review.id, review.author, review.topic, review.text, review.createdAt, user.id);
    audit(req, user, "create", "review", review.id);
    jsonResponse(res, 201, { review: { ...review, status: "pending" } });
    return;
  }

  const reviewStatusMatch = pathname.match(/^\/api\/admin\/reviews\/([^/]+)\/(approve|reject)$/);
  if (req.method === "POST" && reviewStatusMatch) {
    if (!requireModerator(user, res)) return;
    const [, reviewId, action] = reviewStatusMatch;
    const status = action === "approve" ? "approved" : "rejected";
    const result = db.prepare("UPDATE reviews SET status = ?, moderated_at = ?, moderated_by = ? WHERE id = ?").run(status, now(), user.id, reviewId);
    if (!result.changes) {
      jsonResponse(res, 404, { error: "Отзыв не найден" });
      return;
    }
    audit(req, user, status, "review", reviewId);
    jsonResponse(res, 200, { review: reviewRow(db.prepare("SELECT * FROM reviews WHERE id = ?").get(reviewId)) });
    return;
  }

  const reviewDeleteMatch = pathname.match(/^\/api\/admin\/reviews\/([^/]+)$/);
  if (req.method === "DELETE" && reviewDeleteMatch) {
    if (!requireModerator(user, res)) return;
    const result = db.prepare("DELETE FROM reviews WHERE id = ?").run(reviewDeleteMatch[1]);
    if (!result.changes) {
      jsonResponse(res, 404, { error: "Отзыв не найден" });
      return;
    }
    audit(req, user, "delete", "review", reviewDeleteMatch[1]);
    jsonResponse(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/users") {
    if (!requireAdmin(user, res)) return;
    jsonResponse(res, 200, { users: db.prepare("SELECT * FROM users ORDER BY created_at ASC").all().map(publicUser) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/users") {
    if (!requireAdmin(user, res)) return;
    const body = await readBody(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const role = validateRole(body.role);
    const passwordError = validatePassword(password);
    if (!username || passwordError) {
      jsonResponse(res, 400, { error: passwordError || "Укажите логин" });
      return;
    }
    const passwordData = hashPassword(password);
    const id = crypto.randomUUID();
    try {
      db.prepare("INSERT INTO users (id, username, role, password_salt, password_hash, password_iterations, password_algorithm, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, username, role, passwordData.salt, passwordData.hash, passwordData.iterations, passwordData.algorithm, now());
    } catch {
      jsonResponse(res, 409, { error: "Пользователь с таким логином уже есть" });
      return;
    }
    audit(req, user, "create", "user", id, { username, role });
    jsonResponse(res, 201, { user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(id)) });
    return;
  }

  const userUpdateMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (req.method === "PUT" && userUpdateMatch) {
    if (!requireAdmin(user, res)) return;
    const id = userUpdateMatch[1];
    const target = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    if (!target) {
      jsonResponse(res, 404, { error: "Пользователь не найден" });
      return;
    }
    const body = await readBody(req);
    const username = String(body.username || "").trim();
    const role = validateRole(body.role);
    const password = String(body.password || "");
    if (!username) {
      jsonResponse(res, 400, { error: "Логин не может быть пустым" });
      return;
    }
    if (id === user.id && role !== "admin") {
      jsonResponse(res, 400, { error: "Нельзя снять права администратора с текущего пользователя" });
      return;
    }
    if (password) {
      const passwordError = validatePassword(password);
      if (passwordError) {
        jsonResponse(res, 400, { error: passwordError });
        return;
      }
    }
    try {
      if (password) {
        const passwordData = hashPassword(password);
        db.prepare("UPDATE users SET username = ?, role = ?, password_salt = ?, password_hash = ?, password_iterations = ?, password_algorithm = ?, updated_at = ? WHERE id = ?").run(username, role, passwordData.salt, passwordData.hash, passwordData.iterations, passwordData.algorithm, now(), id);
        db.prepare("DELETE FROM sessions WHERE user_id = ? AND user_id != ?").run(id, user.id);
      } else {
        db.prepare("UPDATE users SET username = ?, role = ?, updated_at = ? WHERE id = ?").run(username, role, now(), id);
      }
    } catch {
      jsonResponse(res, 409, { error: "Пользователь с таким логином уже есть" });
      return;
    }
    audit(req, user, "update", "user", id, { username, role, passwordChanged: Boolean(password) });
    jsonResponse(res, 200, { user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(id)) });
    return;
  }

  const userDeleteMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (req.method === "DELETE" && userDeleteMatch) {
    if (!requireAdmin(user, res)) return;
    const id = userDeleteMatch[1];
    if (id === user.id) {
      jsonResponse(res, 400, { error: "Нельзя удалить текущего пользователя" });
      return;
    }
    const result = db.prepare("DELETE FROM users WHERE id = ?").run(id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    if (!result.changes) {
      jsonResponse(res, 404, { error: "Пользователь не найден" });
      return;
    }
    audit(req, user, "delete", "user", id);
    jsonResponse(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/articles") {
    if (!requireAdmin(user, res)) return;
    jsonResponse(res, 200, { articles: db.prepare("SELECT * FROM articles ORDER BY created_at ASC").all().map(articleRow) });
    return;
  }

  const articleDeleteMatch = pathname.match(/^\/api\/admin\/articles\/([^/]+)$/);
  if (req.method === "DELETE" && articleDeleteMatch) {
    if (!requireAdmin(user, res)) return;
    const result = db.prepare("DELETE FROM articles WHERE id = ?").run(articleDeleteMatch[1]);
    if (!result.changes) {
      jsonResponse(res, 404, { error: "Статья не найдена" });
      return;
    }
    audit(req, user, "delete", "article", articleDeleteMatch[1]);
    jsonResponse(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/consultation-requests") {
    const body = await readBody(req);
    const request = {
      id: crypto.randomUUID(),
      name: String(body.name || "").trim(),
      phone: String(body.phone || body.contact || "").trim(),
      format: String(body.format || "").trim(),
      message: String(body.message || "").trim(),
      createdAt: now(),
    };
    if (!request.name || !request.phone) {
      jsonResponse(res, 400, { error: "Укажите имя и контакт" });
      return;
    }
    db.prepare("INSERT INTO consultation_requests (id, name, phone, format, message, status, created_at) VALUES (?, ?, ?, ?, ?, 'new', ?)").run(request.id, request.name, request.phone, request.format, request.message, request.createdAt);
    audit(req, null, "create", "consultation_request", request.id);
    jsonResponse(res, 201, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/consultation-requests") {
    if (!requireAdmin(user, res)) return;
    const url = new URL(req.url, `http://${req.headers.host}`);
    const status = url.searchParams.get("status");
    const sql = status && status !== "all" ? "SELECT * FROM consultation_requests WHERE status = ? ORDER BY created_at DESC" : "SELECT * FROM consultation_requests ORDER BY created_at DESC";
    const rows = status && status !== "all" ? db.prepare(sql).all(status) : db.prepare(sql).all();
    jsonResponse(res, 200, { requests: rows.map(requestRow) });
    return;
  }

  const requestStatusMatch = pathname.match(/^\/api\/admin\/consultation-requests\/([^/]+)\/status$/);
  if (req.method === "PATCH" && requestStatusMatch) {
    if (!requireAdmin(user, res)) return;
    const body = await readBody(req);
    const status = normalizeRequestStatus(String(body.status || ""));
    const result = db.prepare("UPDATE consultation_requests SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), requestStatusMatch[1]);
    if (!result.changes) {
      jsonResponse(res, 404, { error: "Заявка не найдена" });
      return;
    }
    audit(req, user, "status_update", "consultation_request", requestStatusMatch[1], { status });
    jsonResponse(res, 200, { request: requestRow(db.prepare("SELECT * FROM consultation_requests WHERE id = ?").get(requestStatusMatch[1])) });
    return;
  }

  const requestDeleteMatch = pathname.match(/^\/api\/admin\/consultation-requests\/([^/]+)$/);
  if (req.method === "DELETE" && requestDeleteMatch) {
    if (!requireAdmin(user, res)) return;
    const result = db.prepare("DELETE FROM consultation_requests WHERE id = ?").run(requestDeleteMatch[1]);
    if (!result.changes) {
      jsonResponse(res, 404, { error: "Заявка не найдена" });
      return;
    }
    audit(req, user, "delete", "consultation_request", requestDeleteMatch[1]);
    jsonResponse(res, 200, { ok: true });
    return;
  }

  jsonResponse(res, 404, { error: "API endpoint not found" });
}

async function serveStatic(req, res, pathname) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(ROOT, decodeURIComponent(cleanPath)));
  if (!filePath.startsWith(ROOT) || filePath.includes(`${path.sep}data${path.sep}`) || filePath.includes(`${path.sep}.git${path.sep}`)) {
    res.writeHead(403, securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
    res.end("Forbidden");
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      res.writeHead(301, securityHeaders({ Location: `${pathname.replace(/\/$/, "")}/index.html` }));
      res.end();
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const content = await fs.readFile(filePath);
    res.writeHead(200, securityHeaders({
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    }));
    res.end(content);
  } catch {
    res.writeHead(404, securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
    res.end("Not found");
  }
}

initDb();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    jsonResponse(res, 500, { error: "Внутренняя ошибка сервера" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Server is running at http://127.0.0.1:${PORT}/`);
  console.log("Default admin: admin / admin");
});
