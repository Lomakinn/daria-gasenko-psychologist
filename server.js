const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");

const ROOT = __dirname;
const DB_PATH = path.join(ROOT, "data", "db.json");
const SEED_PATH = path.join(ROOT, "data", "seed.json");
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const REQUEST_STATUSES = new Set(["new", "contacted", "intro", "paid", "rejected", "completed"]);

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

function now() {
  return new Date().toISOString();
}

function jsonResponse(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
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

function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie", `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (Buffer.concat(chunks).length > 1024 * 1024) {
      throw new Error("Request body is too large");
    }
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function readDb() {
  await ensureDb();
  const raw = await fs.readFile(DB_PATH, "utf8");
  const db = JSON.parse(raw);
  if (await migrateDb(db)) {
    await writeDb(db);
  }
  db.users ||= [];
  db.sessions ||= [];
  db.reviews ||= [];
  db.articles ||= [];
  db.consultationRequests ||= [];
  return db;
}

async function ensureDb() {
  try {
    await fs.access(DB_PATH);
  } catch {
    await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
    const seed = await fs.readFile(SEED_PATH, "utf8");
    await fs.writeFile(DB_PATH, seed, "utf8");
  }
}

async function readSeed() {
  return JSON.parse(await fs.readFile(SEED_PATH, "utf8"));
}

async function migrateDb(db) {
  const seed = await readSeed();
  if ((db.schemaVersion || 1) >= seed.schemaVersion) return false;

  db.schemaVersion = seed.schemaVersion;
  db.reviews = Array.isArray(db.reviews) && db.reviews.length ? db.reviews : seed.reviews || [];
  db.articles = Array.isArray(db.articles) && db.articles.length ? db.articles : seed.articles || [];
  return true;
}

async function writeDb(db) {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  await fs.writeFile(DB_PATH, `${JSON.stringify(db, null, 2)}\n`, "utf8");
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
  };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return {
    salt,
    hash: crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex"),
  };
}

function verifyPassword(password, user) {
  const { hash } = hashPassword(password, user.passwordSalt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.passwordHash, "hex"));
}

function validateRole(role) {
  return role === "admin" || role === "user" ? role : "user";
}

function canAdmin(user) {
  return user?.role === "admin";
}

function canModerate(user) {
  return user?.role === "admin" || user?.role === "user";
}

function sanitizeReview(review) {
  return {
    id: review.id,
    author: review.author,
    topic: review.topic,
    text: review.text,
    status: review.status,
    createdAt: review.createdAt,
    moderatedAt: review.moderatedAt || null,
    moderatedBy: review.moderatedBy || null,
  };
}

function sanitizeArticle(article) {
  return {
    id: article.id,
    tag: article.tag,
    title: article.title,
    excerpt: article.excerpt,
    href: article.href,
    createdAt: article.createdAt,
  };
}

function sanitizeRequest(request) {
  return {
    id: request.id,
    name: request.name,
    phone: request.phone,
    format: request.format,
    message: request.message,
    createdAt: request.createdAt,
    status: REQUEST_STATUSES.has(request.status) ? request.status : "new",
  };
}

function normalizeRequestStatus(status) {
  return REQUEST_STATUSES.has(status) ? status : "new";
}

async function getCurrentUser(req, db) {
  const token = getCookie(req, "session");
  if (!token) return null;

  const time = Date.now();
  db.sessions = db.sessions.filter((session) => new Date(session.expiresAt).getTime() > time);
  const session = db.sessions.find((item) => item.token === token);
  if (!session) return null;
  return db.users.find((user) => user.id === session.userId) || null;
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

async function handleApi(req, res, pathname) {
  const db = await readDb();
  const user = await getCurrentUser(req, db);

  if (req.method === "POST" && pathname === "/api/auth/login") {
    const body = await readBody(req);
    const found = db.users.find((item) => item.username === String(body.username || "").trim());
    if (!found || !verifyPassword(String(body.password || ""), found)) {
      jsonResponse(res, 401, { error: "Неверный логин или пароль" });
      return;
    }

    const token = crypto.randomBytes(32).toString("hex");
    db.sessions.push({
      token,
      userId: found.id,
      createdAt: now(),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    });
    await writeDb(db);
    setSessionCookie(res, token);
    jsonResponse(res, 200, { user: publicUser(found) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/logout") {
    const token = getCookie(req, "session");
    db.sessions = db.sessions.filter((session) => session.token !== token);
    await writeDb(db);
    clearSessionCookie(res);
    jsonResponse(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/api/auth/me") {
    await writeDb(db);
    jsonResponse(res, 200, { user: user ? publicUser(user) : null });
    return;
  }

  if (req.method === "GET" && pathname === "/api/reviews") {
    const approved = db.reviews
      .filter((review) => review.status === "approved")
      .sort((a, b) => String(b.moderatedAt || b.createdAt).localeCompare(String(a.moderatedAt || a.createdAt)))
      .map(sanitizeReview);
    jsonResponse(res, 200, { reviews: approved });
    return;
  }

  if (req.method === "GET" && pathname === "/api/articles") {
    const articles = db.articles
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map(sanitizeArticle);
    jsonResponse(res, 200, { articles });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/reviews") {
    if (!requireModerator(user, res)) return;
    jsonResponse(res, 200, {
      reviews: db.reviews.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(sanitizeReview),
    });
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
      status: "pending",
      createdAt: now(),
      createdBy: user.id,
    };

    if (!review.author || !review.text) {
      jsonResponse(res, 400, { error: "Заполните автора и текст отзыва" });
      return;
    }

    db.reviews.unshift(review);
    await writeDb(db);
    jsonResponse(res, 201, { review: sanitizeReview(review) });
    return;
  }

  const reviewStatusMatch = pathname.match(/^\/api\/admin\/reviews\/([^/]+)\/(approve|reject)$/);
  if (req.method === "POST" && reviewStatusMatch) {
    if (!requireModerator(user, res)) return;
    const [, reviewId, action] = reviewStatusMatch;
    const review = db.reviews.find((item) => item.id === reviewId);
    if (!review) {
      jsonResponse(res, 404, { error: "Отзыв не найден" });
      return;
    }

    review.status = action === "approve" ? "approved" : "rejected";
    review.moderatedAt = now();
    review.moderatedBy = user.id;
    await writeDb(db);
    jsonResponse(res, 200, { review: sanitizeReview(review) });
    return;
  }

  const reviewDeleteMatch = pathname.match(/^\/api\/admin\/reviews\/([^/]+)$/);
  if (req.method === "DELETE" && reviewDeleteMatch) {
    if (!requireModerator(user, res)) return;
    const before = db.reviews.length;
    db.reviews = db.reviews.filter((review) => review.id !== reviewDeleteMatch[1]);
    if (db.reviews.length === before) {
      jsonResponse(res, 404, { error: "Отзыв не найден" });
      return;
    }
    await writeDb(db);
    jsonResponse(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/users") {
    if (!requireAdmin(user, res)) return;
    jsonResponse(res, 200, { users: db.users.map(publicUser) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/users") {
    if (!requireAdmin(user, res)) return;
    const body = await readBody(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const role = validateRole(body.role);

    if (!username || password.length < 4) {
      jsonResponse(res, 400, { error: "Укажите логин и пароль минимум 4 символа" });
      return;
    }

    if (db.users.some((item) => item.username === username)) {
      jsonResponse(res, 409, { error: "Пользователь с таким логином уже есть" });
      return;
    }

    const passwordData = hashPassword(password);
    const created = {
      id: crypto.randomUUID(),
      username,
      role,
      passwordSalt: passwordData.salt,
      passwordHash: passwordData.hash,
      createdAt: now(),
    };
    db.users.push(created);
    await writeDb(db);
    jsonResponse(res, 201, { user: publicUser(created) });
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
    db.users = db.users.filter((item) => item.id !== id);
    db.sessions = db.sessions.filter((session) => session.userId !== id);
    await writeDb(db);
    jsonResponse(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/articles") {
    if (!requireAdmin(user, res)) return;
    jsonResponse(res, 200, { articles: db.articles.map(sanitizeArticle) });
    return;
  }

  const articleDeleteMatch = pathname.match(/^\/api\/admin\/articles\/([^/]+)$/);
  if (req.method === "DELETE" && articleDeleteMatch) {
    if (!requireAdmin(user, res)) return;
    const before = db.articles.length;
    db.articles = db.articles.filter((article) => article.id !== articleDeleteMatch[1]);
    if (db.articles.length === before) {
      jsonResponse(res, 404, { error: "Статья не найдена" });
      return;
    }
    await writeDb(db);
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
      status: "new",
    };

    if (!request.name || !request.phone) {
      jsonResponse(res, 400, { error: "Укажите имя и контакт" });
      return;
    }

    db.consultationRequests.unshift(request);
    await writeDb(db);
    jsonResponse(res, 201, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/consultation-requests") {
    if (!requireAdmin(user, res)) return;
    const url = new URL(req.url, `http://${req.headers.host}`);
    const status = url.searchParams.get("status");
    const requests = db.consultationRequests
      .map((request) => {
        request.status = normalizeRequestStatus(request.status);
        return request;
      })
      .filter((request) => !status || status === "all" || request.status === status)
      .map(sanitizeRequest);
    jsonResponse(res, 200, { requests });
    return;
  }

  const requestStatusMatch = pathname.match(/^\/api\/admin\/consultation-requests\/([^/]+)\/status$/);
  if (req.method === "PATCH" && requestStatusMatch) {
    if (!requireAdmin(user, res)) return;
    const body = await readBody(req);
    const status = normalizeRequestStatus(String(body.status || ""));
    const request = db.consultationRequests.find((item) => item.id === requestStatusMatch[1]);
    if (!request) {
      jsonResponse(res, 404, { error: "Заявка не найдена" });
      return;
    }
    request.status = status;
    request.updatedAt = now();
    await writeDb(db);
    jsonResponse(res, 200, { request: sanitizeRequest(request) });
    return;
  }

  const requestDeleteMatch = pathname.match(/^\/api\/admin\/consultation-requests\/([^/]+)$/);
  if (req.method === "DELETE" && requestDeleteMatch) {
    if (!requireAdmin(user, res)) return;
    const before = db.consultationRequests.length;
    db.consultationRequests = db.consultationRequests.filter((request) => request.id !== requestDeleteMatch[1]);
    if (db.consultationRequests.length === before) {
      jsonResponse(res, 404, { error: "Заявка не найдена" });
      return;
    }
    await writeDb(db);
    jsonResponse(res, 200, { ok: true });
    return;
  }

  jsonResponse(res, 404, { error: "API endpoint not found" });
}

async function serveStatic(req, res, pathname) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(ROOT, decodeURIComponent(cleanPath)));
  if (!filePath.startsWith(ROOT) || filePath.includes(`${path.sep}data${path.sep}`) || filePath.includes(`${path.sep}.git${path.sep}`)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      res.writeHead(301, { Location: `${pathname.replace(/\/$/, "")}/index.html` });
      res.end();
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const content = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

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
