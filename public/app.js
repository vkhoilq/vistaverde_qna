// Vista Verde Q&A — public/app.js
// Plain ES module, zero dependencies, zero build step.

const DEFAULT_LIMIT = 50;

const state = {
  q: "",
  category: "",
  from: "",
  to: "",
  limit: DEFAULT_LIMIT,
  offset: 0,
  total: 0,
  items: [],
  categories: [],
  loading: false,
};

const els = {
  search: document.getElementById("search"),
  clearSearch: document.getElementById("clear-search"),
  category: document.getElementById("category"),
  fromDate: document.getElementById("from-date"),
  toDate: document.getElementById("to-date"),
  clearFilters: document.getElementById("clear-filters"),
  resultsList: document.getElementById("results-list"),
  resultCount: document.getElementById("result-count"),
  loading: document.getElementById("loading"),
  error: document.getElementById("error"),
  emptyState: document.getElementById("empty-state"),
  loadMore: document.getElementById("load-more"),
  retryBtn: document.getElementById("retry-btn"),
  metaLine: document.getElementById("meta-line"),
};

let debounceTimer = null;

// ----- Formatting helpers -----

function formatDateTime(isoString) {
  if (!isoString) return null;
  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString("vi-VN", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return null;
  }
}

function formatDate(dateString) {
  if (!dateString) return null;
  try {
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleDateString("vi-VN", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    return null;
  }
}

// ----- URL sync -----

function readURL() {
  const params = new URLSearchParams(window.location.search);
  state.q = (params.get("q") || "").trim();
  state.category = params.get("category") || "";
  state.from = params.get("from") || "";
  state.to = params.get("to") || "";
}

function updateURL() {
  const params = new URLSearchParams();
  if (state.q) params.set("q", state.q);
  if (state.category) params.set("category", state.category);
  if (state.from) params.set("from", state.from);
  if (state.to) params.set("to", state.to);

  const query = params.toString();
  const url = query ? `?${query}` : window.location.pathname;
  window.history.replaceState(null, "", url);
}

function buildFetchParams() {
  const params = new URLSearchParams();
  params.set("limit", String(state.limit));
  params.set("offset", String(state.offset));
  if (state.q) params.set("q", state.q);
  if (state.category) params.set("category", state.category);
  if (state.from) params.set("from", state.from);
  if (state.to) params.set("to", state.to);
  return params;
}

// ----- UI helpers -----

function syncInputs() {
  els.search.value = state.q;
  els.category.value = state.category;
  els.fromDate.value = state.from;
  els.toDate.value = state.to;
  updateClearSearch();
  updateClearFilters();
}

function updateClearSearch() {
  els.clearSearch.classList.toggle("hidden", !els.search.value);
}

function hasActiveFilters() {
  return Boolean(state.category || state.from || state.to);
}

function updateClearFilters() {
  els.clearFilters.classList.toggle("hidden", !hasActiveFilters());
}

function setLoading(value) {
  state.loading = value;
  els.loading.classList.toggle("hidden", !value);
  renderResultCount();
}

function setError(value, message) {
  if (value) {
    const title = els.error.querySelector(".error-title");
    const text = els.error.querySelector(".error-text");
    title.textContent = "Không thể tải dữ liệu";
    text.textContent = message && message !== "Không thể tải dữ liệu"
      ? message
      : "Đã có lỗi xảy ra khi kết nối máy chủ. Vui lòng kiểm tra kết nối mạng và thử lại.";
    els.error.classList.remove("hidden");
    els.emptyState.classList.add("hidden");
    els.loadMore.classList.add("hidden");
  } else {
    els.error.classList.add("hidden");
  }
}

function renderMeta(updatedAt) {
  const formatted = formatDateTime(updatedAt);
  els.metaLine.textContent = formatted
    ? `Cập nhật lúc ${formatted}`
    : "Cập nhật lúc —";
}

function renderCategories(categories) {
  const currentValue = els.category.value;
  els.category.innerHTML = '<option value="">Tất cả</option>';

  for (const cat of categories) {
    if (!cat) continue;
    const option = document.createElement("option");
    option.value = cat;
    option.textContent = cat;
    els.category.appendChild(option);
  }

  // Preserve the active selection if it is still a known category.
  const restoreValue = currentValue || state.category;
  if (restoreValue && categories.includes(restoreValue)) {
    els.category.value = restoreValue;
  }
}

function renderResultCount() {
  if (state.loading && state.items.length === 0) {
    els.resultCount.textContent = "Đang tải…";
  } else {
    els.resultCount.textContent = `${state.total} câu hỏi`;
  }
}

function updateLoadMore() {
  els.loadMore.classList.toggle("hidden", state.total <= state.items.length);
}

// ----- Result rendering -----

function createKeywordChip(keyword) {
  const chip = document.createElement("span");
  chip.className = "keyword";
  chip.textContent = keyword;
  return chip;
}

/**
 * Attribution line: who asked and who answered. Returns null when the sheet
 * records neither, so the card stays uncluttered.
 */
function createAttribution(item) {
  const parts = [];
  if (item.asker) parts.push(["Người hỏi", item.asker]);
  if (item.responder) parts.push(["Người trả lời", item.responder]);
  if (parts.length === 0) return null;

  const row = document.createElement("div");
  row.className = "attribution";

  for (const [label, name] of parts) {
    const entry = document.createElement("span");
    entry.className = "attribution-entry";

    const labelEl = document.createElement("span");
    labelEl.className = "attribution-label";
    labelEl.textContent = `${label}:`;

    const nameEl = document.createElement("span");
    nameEl.className = "attribution-name";
    nameEl.textContent = name;

    entry.appendChild(labelEl);
    entry.appendChild(document.createTextNode(" "));
    entry.appendChild(nameEl);
    row.appendChild(entry);
  }

  return row;
}

function createResultItem(item) {
  const li = document.createElement("li");
  li.className = "result-item";

  const header = document.createElement("div");
  header.className = "result-header";

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = item.category || "Khác";
  header.appendChild(badge);
  li.appendChild(header);

  const question = document.createElement("h3");
  question.className = "question";
  question.textContent = item.question || "(Không có tiêu đề)";
  li.appendChild(question);

  const answerText = item.answer || "";
  const answerId = item.id ? 'answer-' + item.id : null;
  const answer = document.createElement("div");
  answer.className = "answer";
  if (answerId) answer.id = answerId;
  answer.textContent = answerText;
  li.appendChild(answer);

  const isLong = answerText.length > 320;
  if (isLong) {
    answer.classList.add("is-long");

    const expandBtn = document.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = "expand-btn";
    expandBtn.textContent = "Xem câu trả lời";
    expandBtn.setAttribute("aria-expanded", "false");
    if (answerId) expandBtn.setAttribute("aria-controls", answerId);
    expandBtn.addEventListener("click", () => {
      const expanded = answer.classList.toggle("expanded");
      expandBtn.textContent = expanded ? "Thu gọn" : "Xem câu trả lời";
      expandBtn.setAttribute("aria-expanded", String(expanded));
    });
    li.appendChild(expandBtn);
  }

  const attribution = createAttribution(item);
  if (attribution) li.appendChild(attribution);

  if (item.keywords && item.keywords.length > 0) {
    const keywords = document.createElement("div");
    keywords.className = "keywords";
    for (const kw of item.keywords) {
      keywords.appendChild(createKeywordChip(kw));
    }
    li.appendChild(keywords);
  }

  const dates = document.createElement("div");
  dates.className = "dates";

  const created = formatDate(item.createdAt);
  if (created) {
    const createdEl = document.createElement("span");
    createdEl.textContent = `Ngày đăng: ${created}`;
    dates.appendChild(createdEl);
  }

  const updated = formatDate(item.updatedAt);
  if (updated) {
    const updatedEl = document.createElement("span");
    updatedEl.textContent = `Cập nhật: ${updated}`;
    dates.appendChild(updatedEl);
  }

  if (dates.children.length > 0) {
    li.appendChild(dates);
  }

  return li;
}

function renderResults() {
  els.resultsList.innerHTML = "";

  const hasItems = state.items.length > 0;
  els.emptyState.classList.toggle("hidden", hasItems || state.loading || !els.error.classList.contains("hidden"));

  for (const item of state.items) {
    els.resultsList.appendChild(createResultItem(item));
  }

  updateLoadMore();
  renderResultCount();
}

// ----- Data fetching -----

async function fetchQA(append = false) {
  if (!append) {
    state.offset = 0;
  }

  setLoading(true);
  setError(false);

  try {
    const params = buildFetchParams();
    const response = await fetch(`/api/qa?${params.toString()}`);

    if (!response.ok) {
      let message = `Lỗi ${response.status}`;
      try {
        const data = await response.json();
        if (data.error && data.error.message) {
          message = data.error.message;
        }
      } catch {
        // Ignore malformed error bodies.
      }
      throw new Error(message);
    }

    const data = await response.json();

    state.total = typeof data.total === "number" ? data.total : 0;
    state.categories = Array.isArray(data.categories) ? data.categories : [];

    const newItems = Array.isArray(data.items) ? data.items : [];
    state.items = append ? [...state.items, ...newItems] : newItems;

    renderCategories(state.categories);
    renderMeta(data.updatedAt);
    renderResults();
  } catch (err) {
    console.error("Failed to fetch QA:", err);
    setError(true, err.message);
    if (state.items.length === 0) {
      els.resultCount.textContent = "Không thể tải dữ liệu";
    }
  } finally {
    setLoading(false);
  }
}

// ----- Event handlers -----

function handleSearch() {
  state.q = els.search.value.trim();
  updateClearSearch();
  updateURL();
  fetchQA(false);
}

function handleFilterChange() {
  state.category = els.category.value;
  state.from = els.fromDate.value;
  state.to = els.toDate.value;
  updateClearFilters();
  updateURL();
  fetchQA(false);
}

function clearSearch() {
  els.search.value = "";
  state.q = "";
  updateClearSearch();
  updateURL();
  fetchQA(false);
}

function clearFilters() {
  state.category = "";
  state.from = "";
  state.to = "";
  els.category.value = "";
  els.fromDate.value = "";
  els.toDate.value = "";
  updateClearFilters();
  updateURL();
  fetchQA(false);
}

function loadMore() {
  if (state.loading || state.items.length >= state.total) return;
  state.offset += state.limit;
  fetchQA(true);
}

// ----- Event listeners -----

els.search.addEventListener("input", () => {
  updateClearSearch();
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(handleSearch, 250);
});

els.search.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    clearTimeout(debounceTimer);
    handleSearch();
  }
});

els.clearSearch.addEventListener("click", clearSearch);

els.category.addEventListener("change", handleFilterChange);
els.fromDate.addEventListener("change", handleFilterChange);
els.toDate.addEventListener("change", handleFilterChange);

els.clearFilters.addEventListener("click", clearFilters);
els.loadMore.addEventListener("click", loadMore);
els.retryBtn.addEventListener("click", () => fetchQA(false));

// ----- Initialize -----

readURL();
syncInputs();
fetchQA(false);
