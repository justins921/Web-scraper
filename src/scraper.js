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
      const seen = new Set();
      const results = [];

      // Given a heading, walk up to find the best wrapping container.
      // Stop when the parent has sibling elements that are also sections
      // (i.e. siblings with their own headings or semantic tags).
      function findContainer(heading) {
        let el = heading;
        while (el.parentElement && el.parentElement !== document.body) {
          // If el itself is a semantic section boundary, use it
          if (["SECTION", "ARTICLE", "ASIDE"].includes(el.tagName)) {
            return el;
          }

          const parent = el.parentElement;

          // Skip past thin wrappers (only one visible child)
          const visibleChildren = Array.from(parent.children).filter(
            (c) => c.offsetHeight > 0 || c.innerHTML.trim().length > 50
          );
          if (visibleChildren.length <= 1) {
            el = parent;
            continue;
          }

          // Parent has multiple visible children — check if siblings
          // look like other sections (have their own headings or are
          // semantic elements). If so, el is our section boundary.
          const siblings = visibleChildren.filter((c) => c !== el);
          const hasSiblingSections = siblings.some(
            (s) =>
              s.querySelector("h1,h2,h3,h4,h5,h6") ||
              ["SECTION", "ARTICLE", "HEADER", "FOOTER", "NAV"].includes(
                s.tagName
              )
          );

          if (hasSiblingSections) {
            return el;
          }

          // Parent is a semantic container — use it
          if (["SECTION", "ARTICLE", "ASIDE"].includes(parent.tagName)) {
            return parent;
          }

          el = parent;
        }
        return el;
      }

      function slugify(text) {
        return text
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 60);
      }

      // 1. Find sections by tracing each heading to its container
      const headings = document.querySelectorAll("h1, h2, h3, h4, h5, h6");
      headings.forEach((h) => {
        const container = findContainer(h);
        if (container && !seen.has(container)) {
          seen.add(container);
          results.push({
            el: container,
            headingText: h.textContent.trim(),
          });
        }
      });

      // 2. Add standalone landmark elements that have no headings
      //    (e.g. a <nav> or <footer> that uses links/icons instead)
      document
        .querySelectorAll("header, nav, footer")
        .forEach((el) => {
          if (!seen.has(el) && el.innerHTML.trim().length > 50) {
            // Make sure this element isn't inside an already-found section
            const isNested = results.some((r) => r.el.contains(el));
            if (!isNested) {
              seen.add(el);
              results.push({ el, headingText: null });
            }
          }
        });

      // 3. Remove any section that is an ancestor of another section
      //    (prefer the more granular children)
      const filtered = results.filter(
        (r) => !results.some((other) => other !== r && r.el.contains(other.el))
      );

      // Sort by document order
      filtered.sort((a, b) => {
        const pos = a.el.compareDocumentPosition(b.el);
        return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });

      // Build output
      return filtered.map((r, i) => {
        const el = r.el;
        const headingText = r.headingText || null;
        let label;

        if (headingText) {
          label = slugify(headingText);
        } else if (el.id) {
          label = el.id;
        } else if (el.getAttribute("aria-label")) {
          label = slugify(el.getAttribute("aria-label"));
        } else {
          label = `${el.tagName.toLowerCase()}-${i + 1}`;
        }

        return {
          label,
          tag: el.tagName.toLowerCase(),
          headingText,
          html: el.outerHTML,
        };
      });
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
        headingText: sec.headingText || null,
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
