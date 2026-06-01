const REVIEW_STORAGE_KEY = "gasenkoReviews";
const form = document.querySelector("[data-review-form]");
const reviewList = document.querySelector("[data-admin-reviews]");

function escapeText(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[char];
  });
}

function getReviews() {
  try {
    return JSON.parse(localStorage.getItem(REVIEW_STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveReviews(reviews) {
  localStorage.setItem(REVIEW_STORAGE_KEY, JSON.stringify(reviews));
}

function renderReviews() {
  const reviews = getReviews();
  reviewList.innerHTML = "";

  if (!reviews.length) {
    reviewList.innerHTML = '<p class="empty-state">Пока нет отзывов, добавленных через админку.</p>';
    return;
  }

  reviews.forEach((review) => {
    const card = document.createElement("article");
    card.className = "admin-review-card";
    card.innerHTML = `
      <p class="tag">${escapeText(review.topic)}</p>
      <p>${escapeText(review.text)}</p>
      <strong>${escapeText(review.author)}</strong>
      <button class="button button-secondary admin-delete" type="button" data-id="${review.id}">Удалить</button>
    `;
    reviewList.append(card);
  });
}

if (form) {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const review = {
      id: crypto.randomUUID(),
      author: String(data.get("author") || "").trim(),
      topic: String(data.get("topic") || "Другое").trim(),
      text: String(data.get("text") || "").trim(),
      createdAt: new Date().toISOString(),
    };

    if (!review.author || !review.text) return;

    saveReviews([review, ...getReviews()]);
    form.reset();
    renderReviews();
  });
}

if (reviewList) {
  reviewList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-id]");
    if (!button) return;
    saveReviews(getReviews().filter((review) => review.id !== button.dataset.id));
    renderReviews();
  });

  renderReviews();
}
