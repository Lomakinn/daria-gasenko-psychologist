const navToggle = document.querySelector(".nav-toggle");
const nav = document.querySelector(".site-nav");
const testDialog = document.querySelector("[data-test-dialog]");
const openTestButtons = document.querySelectorAll("[data-open-test]");
const contactForm = document.querySelector(".contact-form");
const reviewsRoot = document.querySelector("[data-reviews]");
const REVIEW_STORAGE_KEY = "gasenkoReviews";

if (navToggle && nav) {
  navToggle.addEventListener("click", () => {
    const isOpen = nav.classList.toggle("is-open");
    navToggle.setAttribute("aria-expanded", String(isOpen));
  });

  nav.addEventListener("click", (event) => {
    if (event.target instanceof HTMLAnchorElement) {
      nav.classList.remove("is-open");
      navToggle.setAttribute("aria-expanded", "false");
    }
  });
}

openTestButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (testDialog instanceof HTMLDialogElement) {
      testDialog.showModal();
    }
  });
});

if (contactForm) {
  contactForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const button = contactForm.querySelector("button[type='submit']");
    if (button) {
      button.textContent = "Заявка подготовлена";
      button.setAttribute("disabled", "true");
    }
  });
}

function escapeText(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[char];
  });
}

function loadCustomReviews() {
  try {
    return JSON.parse(localStorage.getItem(REVIEW_STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

if (reviewsRoot) {
  const customReviews = loadCustomReviews();
  customReviews.forEach((review) => {
    const blockquote = document.createElement("blockquote");
    blockquote.dataset.customReview = "true";
    blockquote.innerHTML = `
      <p>"${escapeText(review.text)}"</p>
      <cite>${escapeText(review.author || "Анонимно")}</cite>
    `;
    reviewsRoot.append(blockquote);
  });
}
