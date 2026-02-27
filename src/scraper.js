const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

/**
 * Scrape a single page and extract its HTML, CSS, and JS into separate files.
 *
 * @param {string} url - The page URL to scrape
 * @param {string} outputDir - Base output directory
 * @param {object} options
 * @param {boolean} options.keepOriginalHtml - If true, leave <style>/<script> tags in the HTML
 * @param {number} options.timeout - Navigation timeout in ms
 * @param {boolean} options.downloadFonts - If true, download referenced font files
 */
async function scrapePage(url, outputDir, options = {}) {
  const { keepOriginalHtml = false, timeout = 30000 } = options;

  const parsed = new URL(url);
  const slug = (parsed.hostname + parsed.pathname)
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");

  const pageDir = path.join(outputDir, slug);
  fs.mkdirSync(pageDir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    console.log(`Navigating to ${url} ...`);
    await page.goto(url, { waitUntil: "networkidle2", timeout });

    // --- Extract CSS ---
    const cssData = await page.evaluate(() => {
      const parts = [];

      // Inline <style> tags
      document.querySelectorAll("style").forEach((el) => {
        if (el.textContent.trim()) {
          parts.push(`/* === Inline <style> === */\n${el.textContent}`);
        }
      });

      return { inlineParts: parts, stylesheetHrefs: [] };
    });

    // Gather external stylesheet URLs from the page
    const stylesheetHrefs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
        .map((el) => el.href)
        .filter(Boolean);
    });

    // Fetch external stylesheets via Puppeteer (handles CORS)
    const cssParts = [...cssData.inlineParts];
    for (const href of stylesheetHrefs) {
      try {
        const resp = await page.evaluate(async (sheetUrl) => {
          const r = await fetch(sheetUrl);
          return r.ok ? await r.text() : null;
        }, href);
        if (resp) {
          cssParts.push(`/* === External: ${href} === */\n${resp}`);
        }
      } catch {
        console.warn(`  Could not fetch stylesheet: ${href}`);
      }
    }

    // Also grab computed stylesheets from CSSOM (catches @import, etc.)
    const cssomSheets = await page.evaluate(() => {
      const sheets = [];
      for (const sheet of document.styleSheets) {
        try {
          const rules = Array.from(sheet.cssRules || []);
          const text = rules.map((r) => r.cssText).join("\n");
          if (text && !sheet.href) {
            // only CSSOM-only sheets we haven't already captured
            sheets.push(text);
          }
        } catch {
          // cross-origin sheet — already handled via fetch above
        }
      }
      return sheets;
    });
    for (const sheet of cssomSheets) {
      if (!cssParts.some((p) => p.includes(sheet.slice(0, 80)))) {
        cssParts.push(`/* === CSSOM computed === */\n${sheet}`);
      }
    }

    const combinedCss = cssParts.join("\n\n");

    // --- Extract JS ---
    const jsData = await page.evaluate(() => {
      const inlineScripts = [];
      const externalSrcs = [];

      document.querySelectorAll("script").forEach((el) => {
        if (el.src) {
          externalSrcs.push(el.src);
        } else if (el.textContent.trim()) {
          inlineScripts.push(
            `// === Inline <script> ===\n${el.textContent.trim()}`
          );
        }
      });

      return { inlineScripts, externalSrcs };
    });

    const jsParts = [...jsData.inlineScripts];
    for (const src of jsData.externalSrcs) {
      try {
        const resp = await page.evaluate(async (scriptUrl) => {
          const r = await fetch(scriptUrl);
          return r.ok ? await r.text() : null;
        }, src);
        if (resp) {
          jsParts.push(`// === External: ${src} ===\n${resp}`);
        }
      } catch {
        console.warn(`  Could not fetch script: ${src}`);
      }
    }

    const combinedJs = jsParts.join("\n\n");

    // --- Extract HTML ---
    let html = await page.content();

    if (!keepOriginalHtml) {
      // Strip <style> and <link rel="stylesheet"> tags, replace with single ref
      html = html.replace(
        /<style[^>]*>[\s\S]*?<\/style>/gi,
        ""
      );
      html = html.replace(
        /<link[^>]*rel=["']stylesheet["'][^>]*\/?>/gi,
        ""
      );

      // Strip <script> tags, replace with single ref
      html = html.replace(
        /<script[^>]*>[\s\S]*?<\/script>/gi,
        ""
      );

      // Insert references to our extracted files
      html = html.replace(
        "</head>",
        '  <link rel="stylesheet" href="styles.css">\n</head>'
      );
      html = html.replace(
        "</body>",
        '  <script src="scripts.js"></script>\n</body>'
      );
    }

    // Clean up excessive blank lines
    html = html.replace(/\n{3,}/g, "\n\n");

    // --- Extract sections ---
    const sections = await page.evaluate(() => {
      // Selectors for top-level landmark elements, in document order
      const selectors = [
        "header",
        "nav",
        "main",
        "section",
        "article",
        "aside",
        "footer",
      ];

      // Collect all landmark elements that are direct children of body
      // or one level deep (e.g. body > div > section)
      const candidates = [];
      const seen = new Set();

      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach((el) => {
          // Skip deeply nested duplicates — only take elements whose
          // parent is body, or whose grandparent is body
          const depth = getDepthFromBody(el);
          if (depth <= 2 && !seen.has(el)) {
            seen.add(el);
            candidates.push(el);
          }
        });
      }

      // If no semantic landmarks found, fall back to direct children of body
      // that are divs with significant content
      if (candidates.length === 0) {
        document.body.querySelectorAll(":scope > div, :scope > section").forEach((el) => {
          if (el.innerHTML.trim().length > 100 && !seen.has(el)) {
            seen.add(el);
            candidates.push(el);
          }
        });
      }

      // Sort by document order
      candidates.sort((a, b) => {
        const pos = a.compareDocumentPosition(b);
        return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });

      function getDepthFromBody(el) {
        let depth = 0;
        let node = el.parentElement;
        while (node && node !== document.body) {
          depth++;
          node = node.parentElement;
        }
        return depth;
      }

      function labelFor(el, idx) {
        // Try id, aria-label, class, or tag name
        if (el.id) return el.id;
        const aria = el.getAttribute("aria-label");
        if (aria) return aria.toLowerCase().replace(/\s+/g, "-");
        // Use tag name + index
        return `${el.tagName.toLowerCase()}-${idx + 1}`;
      }

      return candidates.map((el, i) => ({
        label: labelFor(el, i),
        tag: el.tagName.toLowerCase(),
        html: el.outerHTML,
      }));
    });

    // Write section files
    const sectionsDir = path.join(pageDir, "sections");
    fs.mkdirSync(sectionsDir, { recursive: true });

    const sectionMeta = sections.map((sec, i) => {
      const filename = `${String(i + 1).padStart(2, "0")}-${sec.label}.html`;
      fs.writeFileSync(path.join(sectionsDir, filename), sec.html, "utf-8");
      return {
        index: i + 1,
        label: sec.label,
        tag: sec.tag,
        file: filename,
        size: Buffer.byteLength(sec.html),
      };
    });

    // --- Write files ---
    fs.writeFileSync(path.join(pageDir, "index.html"), html, "utf-8");
    fs.writeFileSync(path.join(pageDir, "styles.css"), combinedCss, "utf-8");
    fs.writeFileSync(path.join(pageDir, "scripts.js"), combinedJs, "utf-8");

    // Write a metadata file for reference
    const meta = {
      sourceUrl: url,
      scrapedAt: new Date().toISOString(),
      stylesheetCount: stylesheetHrefs.length,
      scriptCount: jsData.externalSrcs.length,
      sectionCount: sectionMeta.length,
      sections: sectionMeta,
      outputDir: pageDir,
    };
    fs.writeFileSync(
      path.join(pageDir, "meta.json"),
      JSON.stringify(meta, null, 2),
      "utf-8"
    );

    console.log(`Done! Files saved to ${pageDir}/`);
    console.log(`  - index.html  (${Buffer.byteLength(html)} bytes)`);
    console.log(`  - styles.css  (${Buffer.byteLength(combinedCss)} bytes)`);
    console.log(`  - scripts.js  (${Buffer.byteLength(combinedJs)} bytes)`);
    console.log(`  - ${sectionMeta.length} sections extracted`);

    return { pageDir, meta };
  } finally {
    await browser.close();
  }
}

/**
 * Scrape multiple pages from the same site.
 */
async function scrapePages(urls, outputDir, options = {}) {
  const results = [];
  for (const url of urls) {
    try {
      const result = await scrapePage(url, outputDir, options);
      results.push(result);
    } catch (err) {
      console.error(`Failed to scrape ${url}: ${err.message}`);
      results.push({ url, error: err.message });
    }
  }
  return results;
}

module.exports = { scrapePage, scrapePages };
