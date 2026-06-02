const loginView = document.querySelector("[data-login-view]");
const adminView = document.querySelector("[data-admin-view]");
const loginForm = document.querySelector("[data-login-form]");
const loginMessage = document.querySelector("[data-login-message]");
const currentUserText = document.querySelector("[data-current-user]");
const logoutButton = document.querySelector("[data-logout]");
const reviewForm = document.querySelector("[data-review-form]");
const reviewMessage = document.querySelector("[data-review-message]");
const reviewList = document.querySelector("[data-admin-reviews]");
const userForm = document.querySelector("[data-user-form]");
const userMessage = document.querySelector("[data-user-message]");
const userList = document.querySelector("[data-admin-users]");
const requestList = document.querySelector("[data-admin-requests]");
const requestStatusFilter = document.querySelector("[data-request-status-filter]");
const articleList = document.querySelector("[data-admin-articles]");
const auditList = document.querySelector("[data-admin-audit]");
const tabButtons = document.querySelectorAll("[data-tab-target]");
const tabPanels = document.querySelectorAll("[data-tab-panel]");
const adminOnlyElements = document.querySelectorAll("[data-admin-only]");

let currentUser = null;
let csrfToken = "";

const requestStatusLabels = {
  new: "Новая",
  contacted: "Связались",
  intro: "Знакомство",
  paid: "Конверсия в платного",
  rejected: "Отказ",
  completed: "Завершили работу",
};

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[char];
  });
}

async function api(path, options = {}) {
  const method = options.method || "GET";
  if (method !== "GET" && !csrfToken) {
    const response = await fetch("/api/csrf", { credentials: "same-origin" });
    const payload = await response.json();
    csrfToken = payload.csrfToken || "";
  }
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(method !== "GET" ? { "X-CSRF-Token": csrfToken } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Ошибка запроса");
  }
  return payload;
}

function setMessage(element, text, isError = false) {
  if (!element) return;
  element.textContent = text;
  element.classList.toggle("form-error", isError);
}

function showApp(user) {
  currentUser = user;
  loginView.hidden = true;
  adminView.hidden = false;
  currentUserText.textContent = `${user.username} · ${user.role === "admin" ? "админ" : "обычный юзер"}`;

  adminOnlyElements.forEach((element) => {
    element.hidden = user.role !== "admin";
  });

  if (user.role !== "admin") {
    switchTab("reviews");
  }

  loadReviews();
  if (user.role === "admin") {
    loadUsers();
    loadRequests();
    loadArticles();
    loadAudit();
  }
}

function showLogin() {
  currentUser = null;
  loginView.hidden = false;
  adminView.hidden = true;
}

function switchTab(name) {
  tabButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tabTarget === name);
  });
  tabPanels.forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.tabPanel === name);
  });
}

function statusLabel(status) {
  if (status === "approved") return "Опубликован";
  if (status === "rejected") return "Отклонен";
  return "На проверке";
}

function renderReviews(reviews) {
  if (!reviewList) return;
  reviewList.innerHTML = "";
  if (!reviews.length) {
    reviewList.innerHTML = '<p class="empty-state">Отзывов в базе пока нет.</p>';
    return;
  }

  reviews.forEach((review) => {
    const card = document.createElement("article");
    card.className = "admin-card";
    card.innerHTML = `
      <div class="admin-card-top">
        <p class="tag">${escapeText(review.topic || "Другое")}</p>
        <span class="status-pill status-${escapeText(review.status)}">${statusLabel(review.status)}</span>
      </div>
      <p>${escapeText(review.text)}</p>
      <strong>${escapeText(review.author || "Анонимно")}</strong>
      <small>${new Date(review.createdAt).toLocaleString("ru-RU")}</small>
      <div class="admin-actions">
        <button class="button button-primary" type="button" data-review-action="approve" data-id="${review.id}">Одобрить</button>
        <button class="button button-secondary" type="button" data-review-action="reject" data-id="${review.id}">Отклонить</button>
        <button class="button button-danger" type="button" data-review-action="delete" data-id="${review.id}">Удалить</button>
      </div>
    `;
    reviewList.append(card);
  });
}

async function loadReviews() {
  const payload = await api("/api/admin/reviews");
  renderReviews(payload.reviews);
}

function renderUsers(users) {
  if (!userList) return;
  userList.innerHTML = "";
  users.forEach((user) => {
    const card = document.createElement("article");
    card.className = "admin-card";
    card.innerHTML = `
      <div class="admin-card-top">
        <strong>${escapeText(user.username)}</strong>
        <span class="status-pill">${user.role === "admin" ? "Админ" : "Обычный юзер"}</span>
      </div>
      <p>Создан ${new Date(user.createdAt).toLocaleDateString("ru-RU")}</p>
      <div class="admin-edit-grid">
        <label>
          Ник
          <input type="text" value="${escapeText(user.username)}" data-user-username="${user.id}" />
        </label>
        <label>
          Новый пароль
          <input type="password" placeholder="Оставьте пустым, если без изменений" data-user-password="${user.id}" />
        </label>
        <label>
          Права
          <select data-user-role="${user.id}">
            <option value="user" ${user.role === "user" ? "selected" : ""}>Обычный юзер</option>
            <option value="admin" ${user.role === "admin" ? "selected" : ""}>Админ</option>
          </select>
        </label>
      </div>
      <div class="admin-actions">
        <button class="button button-primary" type="button" data-user-save="${user.id}">Сохранить</button>
        <button class="button button-danger" type="button" data-user-delete="${user.id}" ${user.id === currentUser.id ? "disabled" : ""}>Удалить</button>
      </div>
    `;
    userList.append(card);
  });
}

async function loadUsers() {
  if (currentUser?.role !== "admin") return;
  const payload = await api("/api/admin/users");
  renderUsers(payload.users);
}

function renderRequests(requests) {
  if (!requestList) return;
  requestList.innerHTML = "";
  if (!requests.length) {
    requestList.innerHTML = '<p class="empty-state">Заявок пока нет.</p>';
    return;
  }

  requests.forEach((request) => {
    const status = request.status || "new";
    const card = document.createElement("article");
    card.className = "admin-card";
    card.innerHTML = `
      <div class="admin-card-top">
        <div>
          <strong>${escapeText(request.name)}</strong>
          <p class="status-pill status-request status-request-${escapeText(status)}">${escapeText(requestStatusLabels[status] || requestStatusLabels.new)}</p>
        </div>
        <small>${new Date(request.createdAt).toLocaleString("ru-RU")}</small>
      </div>
      <p><b>Контакт:</b> ${escapeText(request.phone)}</p>
      <p><b>Формат:</b> ${escapeText(request.format || "Не указан")}</p>
      <p>${escapeText(request.message || "Без сообщения")}</p>
      <label class="admin-status-control">
        Состояние заявки
        <select data-request-status="${request.id}">
          ${Object.entries(requestStatusLabels)
            .map(([value, label]) => `<option value="${value}" ${status === value ? "selected" : ""}>${label}</option>`)
            .join("")}
        </select>
      </label>
      <div class="admin-actions">
        <button class="button button-danger" type="button" data-request-delete="${request.id}">Удалить</button>
      </div>
    `;
    requestList.append(card);
  });
}

async function loadRequests() {
  if (currentUser?.role !== "admin") return;
  const status = requestStatusFilter?.value || "all";
  const payload = await api(`/api/admin/consultation-requests?status=${encodeURIComponent(status)}`);
  renderRequests(payload.requests);
}

function renderArticles(articles) {
  if (!articleList) return;
  articleList.innerHTML = "";
  if (!articles.length) {
    articleList.innerHTML = '<p class="empty-state">Статей в базе пока нет.</p>';
    return;
  }

  articles.forEach((article) => {
    const card = document.createElement("article");
    card.className = "admin-card";
    card.innerHTML = `
      <div class="admin-card-top">
        <p class="tag">${escapeText(article.tag || "Статья")}</p>
        <a class="admin-inline-link" href="${escapeText(article.href)}" target="_blank" rel="noreferrer">Открыть</a>
      </div>
      <strong>${escapeText(article.title)}</strong>
      <p>${escapeText(article.excerpt || "")}</p>
      <small>${escapeText(article.href)}</small>
      <div class="admin-actions">
        <button class="button button-danger" type="button" data-article-delete="${article.id}">Удалить</button>
      </div>
    `;
    articleList.append(card);
  });
}

async function loadArticles() {
  if (currentUser?.role !== "admin") return;
  const payload = await api("/api/admin/articles");
  renderArticles(payload.articles);
}

function renderAudit(logs) {
  if (!auditList) return;
  auditList.innerHTML = "";
  if (!logs.length) {
    auditList.innerHTML = '<p class="empty-state">Событий пока нет.</p>';
    return;
  }
  logs.forEach((log) => {
    const card = document.createElement("article");
    card.className = "admin-card";
    card.innerHTML = `
      <div class="admin-card-top">
        <strong>${escapeText(log.action)} · ${escapeText(log.entity_type)}</strong>
        <small>${new Date(log.created_at).toLocaleString("ru-RU")}</small>
      </div>
      <p><b>ID:</b> ${escapeText(log.entity_id || "—")}</p>
      <p><b>User:</b> ${escapeText(log.user_id || "public")}</p>
      <p><b>IP:</b> ${escapeText(log.ip || "—")}</p>
    `;
    auditList.append(card);
  });
}

async function loadAudit() {
  if (currentUser?.role !== "admin") return;
  const payload = await api("/api/admin/audit");
  renderAudit(payload.logs || []);
}

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(loginForm));
  try {
    const payload = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(data),
    });
    setMessage(loginMessage, "");
    showApp(payload.user);
  } catch (error) {
    setMessage(loginMessage, error.message, true);
  }
});

logoutButton?.addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  showLogin();
});

tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (button.hidden) return;
    switchTab(button.dataset.tabTarget);
  });
});

reviewForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(reviewForm));
  try {
    await api("/api/admin/reviews", {
      method: "POST",
      body: JSON.stringify(data),
    });
    reviewForm.reset();
    setMessage(reviewMessage, "Отзыв отправлен на проверку.");
    loadReviews();
  } catch (error) {
    setMessage(reviewMessage, error.message, true);
  }
});

reviewList?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-review-action]");
  if (!button) return;
  const id = button.dataset.id;
  const action = button.dataset.reviewAction;
  try {
    if (action === "delete") {
      if (!confirm("Удалить отзыв?")) return;
      await api(`/api/admin/reviews/${id}`, { method: "DELETE" });
    } else {
      await api(`/api/admin/reviews/${id}/${action}`, { method: "POST" });
    }
    loadReviews();
  } catch (error) {
    alert(error.message);
  }
});

userForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(userForm));
  try {
    await api("/api/admin/users", {
      method: "POST",
      body: JSON.stringify(data),
    });
    userForm.reset();
    setMessage(userMessage, "Пользователь добавлен.");
    loadUsers();
  } catch (error) {
    setMessage(userMessage, error.message, true);
  }
});

userList?.addEventListener("click", async (event) => {
  const deleteButton = event.target.closest("[data-user-delete]");
  const saveButton = event.target.closest("[data-user-save]");

  if (deleteButton && !deleteButton.disabled) {
    if (!confirm("Удалить пользователя?")) return;
    try {
      await api(`/api/admin/users/${deleteButton.dataset.userDelete}`, { method: "DELETE" });
      loadUsers();
    } catch (error) {
      alert(error.message);
    }
    return;
  }

  if (saveButton) {
    const id = saveButton.dataset.userSave;
    const username = userList.querySelector(`[data-user-username="${CSS.escape(id)}"]`)?.value || "";
    const password = userList.querySelector(`[data-user-password="${CSS.escape(id)}"]`)?.value || "";
    const role = userList.querySelector(`[data-user-role="${CSS.escape(id)}"]`)?.value || "user";
    try {
      await api(`/api/admin/users/${id}`, {
        method: "PUT",
        body: JSON.stringify({ username, password, role }),
      });
      loadUsers();
    } catch (error) {
      alert(error.message);
    }
  }
});

requestList?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-request-delete]");
  if (!button) return;
  if (!confirm("Удалить заявку?")) return;
  try {
    await api(`/api/admin/consultation-requests/${button.dataset.requestDelete}`, { method: "DELETE" });
    loadRequests();
  } catch (error) {
    alert(error.message);
  }
});

requestList?.addEventListener("change", async (event) => {
  const select = event.target.closest("[data-request-status]");
  if (!select) return;
  try {
    await api(`/api/admin/consultation-requests/${select.dataset.requestStatus}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: select.value }),
    });
    loadRequests();
  } catch (error) {
    alert(error.message);
  }
});

articleList?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-article-delete]");
  if (!button) return;
  if (!confirm("Удалить статью из базы?")) return;
  try {
    await api(`/api/admin/articles/${button.dataset.articleDelete}`, { method: "DELETE" });
    loadArticles();
  } catch (error) {
    alert(error.message);
  }
});

document.querySelector("[data-refresh-reviews]")?.addEventListener("click", loadReviews);
document.querySelector("[data-refresh-requests]")?.addEventListener("click", loadRequests);
document.querySelector("[data-refresh-articles]")?.addEventListener("click", loadArticles);
document.querySelector("[data-refresh-audit]")?.addEventListener("click", loadAudit);
requestStatusFilter?.addEventListener("change", loadRequests);

api("/api/auth/me")
  .then((payload) => {
    if (payload.user) {
      showApp(payload.user);
    } else {
      showLogin();
    }
  })
  .catch(() => showLogin());
