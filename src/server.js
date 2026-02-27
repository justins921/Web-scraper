const express = require("express");
const path = require("path");
const fs = require("fs");
const { scrapePage } = require("./scraper");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Serve scraped files for preview / download
const defaultOutput = path.resolve("./scraped");

app.get("/api/output-dir", (_req, res) => {
  res.json({ outputDir: defaultOutput });
});

/**
 * POST /api/scrape
 * Body: { urls: string[], options?: { keepOriginalHtml, timeout, output } }
 */
app.post("/api/scrape", async (req, res) => {
  const { urls, options = {} } = req.body;

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: "Provide at least one URL." });
  }

  // Validate URLs
  for (const u of urls) {
    try {
      new URL(u);
    } catch {
      return res.status(400).json({ error: `Invalid URL: ${u}` });
    }
  }

  const outputDir = options.output
    ? path.resolve(options.output)
    : defaultOutput;
  const scrapeOptions = {
    keepOriginalHtml: options.keepOriginalHtml || false,
    timeout: options.timeout || 30000,
  };

  const results = [];

  for (const url of urls) {
    try {
      const result = await scrapePage(url, outputDir, scrapeOptions);
      results.push({ url, success: true, ...result });
    } catch (err) {
      results.push({ url, success: false, error: err.message });
    }
  }

  res.json({ results, outputDir });
});

/**
 * GET /api/results
 * List previously scraped sites from the output directory.
 */
app.get("/api/results", (_req, res) => {
  if (!fs.existsSync(defaultOutput)) {
    return res.json({ sites: [] });
  }

  const entries = fs.readdirSync(defaultOutput, { withFileTypes: true });
  const sites = entries
    .filter((e) => e.isDirectory())
    .map((e) => {
      const metaPath = path.join(defaultOutput, e.name, "meta.json");
      let meta = null;
      if (fs.existsSync(metaPath)) {
        meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      }
      return { slug: e.name, meta };
    })
    .filter((s) => s.meta);

  res.json({ sites });
});

/**
 * GET /api/results/:slug/:file
 * Serve a specific scraped file for preview / download.
 */
app.get("/api/results/:slug/:file", (req, res) => {
  const { slug, file } = req.params;
  const allowed = ["index.html", "styles.css", "scripts.js", "meta.json"];
  if (!allowed.includes(file)) {
    return res.status(403).json({ error: "File not allowed." });
  }

  const filePath = path.join(defaultOutput, slug, file);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found." });
  }

  res.sendFile(filePath);
});

/**
 * GET /api/results/:slug/download
 * Download all scraped files as a .tar.gz (streamed via tar).
 * Falls back to zip-like JSON bundle if tar is unavailable.
 */
app.get("/api/results/:slug/download", (req, res) => {
  const { slug } = req.params;
  const dir = path.join(defaultOutput, slug);

  if (!fs.existsSync(dir)) {
    return res.status(404).json({ error: "Not found." });
  }

  const files = ["index.html", "styles.css", "scripts.js", "meta.json"];
  const bundle = {};
  for (const f of files) {
    const fp = path.join(dir, f);
    if (fs.existsSync(fp)) {
      bundle[f] = fs.readFileSync(fp, "utf-8");
    }
  }

  res.setHeader("Content-Disposition", `attachment; filename="${slug}.json"`);
  res.json(bundle);
});

app.listen(PORT, () => {
  console.log(`\n  Web Scraper GUI running at http://localhost:${PORT}\n`);
});
