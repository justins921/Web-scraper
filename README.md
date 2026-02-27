# Web Scraper

Scrape individual web pages and extract their **HTML**, **CSS**, and **JavaScript** into separate files — ready to paste into [Flowboard](https://flowboardapp.com) for client website migration.

## How It Works

The scraper uses Puppeteer (headless Chrome) to fully render each page, then:

1. **CSS** — collects all `<style>` tags, external stylesheets (`<link rel="stylesheet">`), and CSSOM-computed rules into a single `styles.css`
2. **JS** — collects all inline `<script>` blocks and external script files into a single `scripts.js`
3. **HTML** — saves the rendered HTML with `<style>`/`<script>` tags stripped out and replaced by references to `styles.css` and `scripts.js`
4. **Metadata** — saves a `meta.json` with the source URL, timestamp, and asset counts

Each page gets its own folder under the output directory.

## Setup

```bash
npm install
```

## Usage

### Scrape a single page

```bash
npm run scrape -- https://example.com
```

### Scrape multiple pages

```bash
npm run scrape -- https://example.com https://example.com/about https://example.com/contact
```

### Options

| Flag | Alias | Description | Default |
|------|-------|-------------|---------|
| `--output` | `-o` | Output directory | `./scraped` |
| `--keep-original` | `-k` | Keep `<style>`/`<script>` tags in the HTML instead of extracting | `false` |
| `--timeout` | `-t` | Navigation timeout (ms) | `30000` |

### Examples

```bash
# Scrape into a custom directory
npm run scrape -- https://example.com -o ./client-site

# Keep styles/scripts inline in the HTML
npm run scrape -- https://example.com -k

# Longer timeout for slow sites
npm run scrape -- https://example.com -t 60000
```

## Output Structure

```
scraped/
  example_com/
    index.html     # Clean HTML with refs to styles.css & scripts.js
    styles.css     # All CSS combined
    scripts.js     # All JS combined
    meta.json      # Source URL, timestamp, asset counts
  example_com_about/
    index.html
    styles.css
    scripts.js
    meta.json
```

## Using with Flowboard

1. Run the scraper on the client's website pages
2. Open each page's output folder
3. Paste `index.html` into Flowboard's HTML editor
4. Paste `styles.css` into the CSS section
5. Paste `scripts.js` into the JS section
6. Adjust asset paths (images, fonts) as needed
