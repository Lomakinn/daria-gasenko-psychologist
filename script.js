const navToggle = document.querySelector(".nav-toggle");
const nav = document.querySelector(".site-nav");
const testDialog = document.querySelector("[data-test-dialog]");
const openTestButtons = document.querySelectorAll("[data-open-test]");
const closeTestButton = document.querySelector("[data-close-test]");
const gadForm = document.querySelector("[data-gad-form]");
const gadContent = document.querySelector("[data-gad-content]");
const gadResult = document.querySelector("[data-gad-result]");
const contactForm = document.querySelector(".contact-form");
const reviewsRoot = document.querySelector("[data-reviews]");
const reviewTrack = document.querySelector("[data-reviews]");
const reviewPrev = document.querySelector("[data-review-prev]");
const reviewNext = document.querySelector("[data-review-next]");
const reviewCounter = document.querySelector("[data-review-counter]");
const blogRoot = document.querySelector("[data-blog]");
let modalScrollY = 0;

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
      if (gadResult) {
        gadResult.hidden = true;
        gadResult.textContent = "";
      }
      if (gadContent) {
        gadContent.hidden = false;
      }
      if (gadForm) {
        gadForm.reset();
        gadForm.scrollTop = 0;
      }
      lockPageScroll();
      testDialog.showModal();
    }
  });
});

if (closeTestButton && testDialog instanceof HTMLDialogElement) {
  closeTestButton.addEventListener("click", () => testDialog.close());
}

if (testDialog instanceof HTMLDialogElement) {
  testDialog.addEventListener("close", unlockPageScroll);
  testDialog.addEventListener("cancel", unlockPageScroll);
}

function lockPageScroll() {
  modalScrollY = window.scrollY;
  document.body.classList.add("modal-open");
  document.body.style.top = `-${modalScrollY}px`;
}

function unlockPageScroll() {
  document.body.classList.remove("modal-open");
  document.body.style.top = "";
  window.scrollTo(0, modalScrollY);
}

function getGadInterpretation(score) {
  if (score <= 4) {
    return {
      level: "Минимальный уровень тревожности",
      text: "Сейчас ответы не показывают выраженной тревожной нагрузки. Если напряжение все же субъективно мешает вам, это уже достаточный повод поговорить со специалистом.",
    };
  }

  if (score <= 9) {
    return {
      level: "Легкий уровень тревожности",
      text: "Симптомы стоит отслеживать: сон, нагрузку, раздражительность, телесное напряжение. Консультация может помочь понять, что поддерживает тревогу и как мягко снизить ее влияние.",
    };
  }

  if (score <= 14) {
    return {
      level: "Умеренный уровень тревожности",
      text: "Такой результат часто говорит, что тревога уже заметно влияет на повседневную жизнь. Рекомендуется обсудить состояние со специалистом и выбрать понятный план поддержки.",
    };
  }

  return {
    level: "Высокий уровень тревожности",
    text: "Лучше не оставаться с этим в одиночку. Стоит обратиться к психологу, психотерапевту или врачу-психиатру для очной оценки состояния и подбора помощи.",
  };
}

if (gadForm && gadResult) {
  gadForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(gadForm);
    const scores = Array.from({ length: 7 }, (_, index) => data.get(`gad${index + 1}`));

    if (scores.some((value) => value === null)) {
      gadResult.hidden = false;
      gadResult.className = "gad-result gad-result-warning";
      gadResult.innerHTML = "<strong>Ответьте на все 7 вопросов.</strong><p>После этого тест сразу покажет результат.</p>";
      return;
    }

    const total = scores.reduce((sum, value) => sum + Number(value), 0);
    const interpretation = getGadInterpretation(total);
    if (gadContent) {
      gadContent.hidden = true;
    }
    gadForm.scrollTop = 0;
    gadResult.hidden = false;
    gadResult.className = "gad-result";
    gadResult.innerHTML = `
      <p class="eyebrow">Результат GAD-7</p>
      <h2>${total} из 21</h2>
      <strong>${interpretation.level}</strong>
      <p>${interpretation.text}</p>
      <div class="gad-result-actions">
        <a class="button button-primary" href="#contact">Записаться на знакомство</a>
        <button class="button button-secondary" type="button" data-restart-gad>Пройти заново</button>
      </div>
    `;
  });

  gadResult.addEventListener("click", (event) => {
    if (event.target instanceof HTMLAnchorElement && testDialog instanceof HTMLDialogElement) {
      testDialog.close();
      return;
    }

    if (event.target instanceof HTMLButtonElement && event.target.matches("[data-restart-gad]")) {
      gadForm.reset();
      gadResult.hidden = true;
      gadResult.textContent = "";
      if (gadContent) {
        gadContent.hidden = false;
      }
      gadForm.scrollTop = 0;
    }
  });
}

if (contactForm) {
  contactForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const button = contactForm.querySelector("button[type='submit']");
    const originalText = button?.textContent || "";
    const data = Object.fromEntries(new FormData(contactForm));

    if (button) {
      button.textContent = "Отправляем...";
      button.setAttribute("disabled", "true");
    }

    fetch("/api/consultation-requests", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    })
      .then((response) => {
        if (!response.ok) throw new Error("Request failed");
        contactForm.reset();
        if (button) button.textContent = "Заявка отправлена";
      })
      .catch(() => {
        if (button) button.textContent = "Заявка подготовлена";
      })
      .finally(() => {
        window.setTimeout(() => {
          if (button) {
            button.textContent = originalText;
            button.removeAttribute("disabled");
          }
        }, 3000);
      });
  });
}

function escapeText(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[char];
  });
}

function getVisibleReviewCount() {
  return window.matchMedia("(max-width: 940px)").matches ? 1 : 3;
}

async function loadApprovedReviews() {
  if (!reviewsRoot) return;

  try {
    const response = await fetch("/api/reviews", { credentials: "same-origin" });
    if (!response.ok) return;
    const payload = await response.json();
    const reviews = Array.isArray(payload.reviews) ? payload.reviews : [];
    reviewsRoot.innerHTML = "";
    reviews.forEach((review) => {
      const blockquote = document.createElement("blockquote");
      blockquote.innerHTML = `
        <p>"${escapeText(review.text)}"</p>
        <cite>${escapeText(review.author || "Анонимно")}</cite>
      `;
      reviewsRoot.append(blockquote);
    });
  } catch {
    // Static hosting without the backend keeps the base reviews visible.
  }
}

function setupReviewCarousel() {
  if (!reviewTrack || !reviewPrev || !reviewNext || !reviewCounter) return;

  let currentIndex = 0;

  function updateCarousel() {
    const slides = Array.from(reviewTrack.querySelectorAll("blockquote"));
    const visibleCount = getVisibleReviewCount();
    const maxIndex = Math.max(0, slides.length - visibleCount);
    currentIndex = Math.min(currentIndex, maxIndex);
    const slideWidth = slides[0]?.getBoundingClientRect().width || 0;
    const gap = Number.parseFloat(getComputedStyle(reviewTrack).columnGap || "0");
    reviewTrack.style.transform = `translateX(-${currentIndex * (slideWidth + gap)}px)`;
    reviewPrev.disabled = currentIndex === 0;
    reviewNext.disabled = currentIndex >= maxIndex;
    const firstVisible = slides.length ? currentIndex + 1 : 0;
    const lastVisible = Math.min(currentIndex + visibleCount, slides.length);
    reviewCounter.textContent = firstVisible === lastVisible ? `${lastVisible} / ${slides.length}` : `${firstVisible}-${lastVisible} / ${slides.length}`;
  }

  reviewPrev.addEventListener("click", () => {
    currentIndex = Math.max(0, currentIndex - getVisibleReviewCount());
    updateCarousel();
  });

  reviewNext.addEventListener("click", () => {
    const slides = Array.from(reviewTrack.querySelectorAll("blockquote"));
    const visibleCount = getVisibleReviewCount();
    currentIndex = Math.min(Math.max(0, slides.length - visibleCount), currentIndex + visibleCount);
    updateCarousel();
  });

  window.addEventListener("resize", updateCarousel);
  loadApprovedReviews().finally(updateCarousel);
}

async function loadArticles() {
  if (!blogRoot) return;

  try {
    const response = await fetch("/api/articles", { credentials: "same-origin" });
    if (!response.ok) return;
    const payload = await response.json();
    const articles = Array.isArray(payload.articles) ? payload.articles : [];
    blogRoot.innerHTML = "";
    articles.forEach((article) => {
      const card = document.createElement("a");
      card.className = "blog-card";
      card.href = article.href;
      card.innerHTML = `
        <p class="tag">${escapeText(article.tag || "Статья")}</p>
        <h3>${escapeText(article.title)}</h3>
        <p>${escapeText(article.excerpt || "")}</p>
        <span class="read-more">Читать статью</span>
      `;
      blogRoot.append(card);
    });
  } catch {
    // Static hosting without the backend leaves the section empty.
  }
}

setupReviewCarousel();
loadArticles();
