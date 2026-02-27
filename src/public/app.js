/* ── DOM refs ── */
const form = document.getElementById("scrape-form");
const urlFields = document.getElementById("url-fields");
const addUrlBtn = document.getElementById("add-url");
const scrapeBtn = document.getElementById("scrape-btn");
const progress = document.getElementById("progress");
const progressFill = document.getElementById("progress-fill");
const progressText = document.getElementById("progress-text");
const resultsList = document.getElementById("results-list");
const modal = document.getElementById("modal");
const modalTitle = document.getElementById("modal-title");
const modalClose = document.getElementById("modal-close");
const previewCode = document.getElementById("preview-code");
const previewIframe = document.getElementById("preview-iframe");
const tabs = document.querySelectorAll(".tab");

/* ── URL rows ── */
addUrlBtn.addEventListener("click", () => {
  const row = document.createElement("div");
  row.className = "url-row";
  row.innerHTML = `
    <input type="url" name="url" placeholder="https://example.com" required />
    <button type="button" class="btn-icon remove-url" title="Remove">&times;</button>
  `;
  urlFields.appendChild(row);
  updateRemoveButtons();
});

urlFields.addEventListener("click", (e) => {
  if (e.target.classList.contains("remove-url")) {
    e.target.closest(".url-row").remove();
    updateRemoveButtons();
  }
});

function updateRemoveButtons() {
  const rows = urlFields.querySelectorAll(".url-row");
  rows.forEach((row) => {
    const btn = row.querySelector(".remove-url");
    btn.hidden = rows.length <= 1;
  });
}

/* ── Form submission ── */
form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const inputs = urlFields.querySelectorAll('input[type="url"]');
  const urls = Array.from(inputs)
    .map((i) => i.value.trim())
    .filter(Boolean);

  if (urls.length === 0) return;

  const options = {
    keepOriginalHtml: document.getElementById("opt-keep").checked,
    timeout: parseInt(document.getElementById("opt-timeout").value, 10) || 30000,
  };

  // Show progress
  scrapeBtn.disabled = true;
  progress.hidden = false;
  progressFill.style.width = "0%";
  progressFill.classList.add("indeterminate");
  progressText.textContent = `Scraping ${urls.length} URL${urls.length > 1 ? "s" : ""}...`;

  try {
    const res = await fetch("/api/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls, options }),
    });

    const data = await res.json();

    if (!res.ok) {
      progressFill.classList.remove("indeterminate");
      progressFill.style.width = "100%";
      progressFill.style.background = "var(--error)";
      progressText.textContent = data.error || "Scrape failed.";
      return;
    }

    // Success
    progressFill.classList.remove("indeterminate");
    progressFill.style.width = "100%";
    progressFill.style.background = "var(--success)";

    const ok = data.results.filter((r) => r.success).length;
    const fail = data.results.length - ok;
    progressText.textContent = `Done! ${ok} succeeded${fail ? `, ${fail} failed` : ""}.`;

    loadResults();
  } catch (err) {
    progressFill.classList.remove("indeterminate");
    progressFill.style.width = "100%";
    progressFill.style.background = "var(--error)";
    progressText.textContent = `Error: ${err.message}`;
  } finally {
    scrapeBtn.disabled = false;
  }
});

/* ── Load previously scraped results ── */
async function loadResults() {
  try {
    const res = await fetch("/api/results");
    const data = await res.json();

    if (!data.sites || data.sites.length === 0) {
      resultsList.innerHTML = '<p class="muted">No sites scraped yet.</p>';
      return;
    }

    // Sort by date descending
    data.sites.sort(
      (a, b) => new Date(b.meta.scrapedAt) - new Date(a.meta.scrapedAt)
    );

    resultsList.innerHTML = data.sites.map((site) => `
      <div class="result-card" data-slug="${site.slug}">
        <div class="result-header">
          <span class="result-url">${escapeHtml(site.meta.sourceUrl)}</span>
          <span class="result-date">${new Date(site.meta.scrapedAt).toLocaleString()}</span>
        </div>
        <div class="result-actions">
          <button class="btn-sm" onclick="openPreview('${site.slug}', '${escapeHtml(site.meta.sourceUrl)}')">
            Preview
          </button>
          <button class="btn-sm" onclick="downloadBundle('${site.slug}')">
            Download
          </button>
        </div>
      </div>
    `).join("");
  } catch {
    resultsList.innerHTML = '<p class="muted">Could not load results.</p>';
  }
}

/* ── Preview modal ── */
let currentSlug = null;
let previewCache = {};

async function openPreview(slug, url) {
  currentSlug = slug;
  previewCache = {};
  modalTitle.textContent = url;
  modal.hidden = false;

  // Default to HTML tab
  tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === "html"));
  loadTab("html");
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    loadTab(tab.dataset.tab);
  });
});

async function loadTab(tabName) {
  previewCode.hidden = tabName === "rendered";
  previewIframe.hidden = tabName !== "rendered";

  if (tabName === "rendered") {
    previewIframe.src = `/api/results/${currentSlug}/index.html`;
    return;
  }

  const fileMap = { html: "index.html", css: "styles.css", js: "scripts.js" };
  const file = fileMap[tabName];

  if (previewCache[file]) {
    previewCode.textContent = previewCache[file];
    return;
  }

  previewCode.textContent = "Loading...";
  try {
    const res = await fetch(`/api/results/${currentSlug}/${file}`);
    const text = await res.text();
    previewCache[file] = text;
    previewCode.textContent = text;
  } catch {
    previewCode.textContent = "Failed to load file.";
  }
}

modalClose.addEventListener("click", () => {
  modal.hidden = true;
  previewIframe.src = "";
});

modal.addEventListener("click", (e) => {
  if (e.target === modal) {
    modal.hidden = true;
    previewIframe.src = "";
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modal.hidden) {
    modal.hidden = true;
    previewIframe.src = "";
  }
});

/* ── Download ── */
async function downloadBundle(slug) {
  try {
    const res = await fetch(`/api/results/${slug}/download`);
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${slug}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch {
    alert("Download failed.");
  }
}

/* ── Helpers ── */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/* ── Init ── */
loadResults();
