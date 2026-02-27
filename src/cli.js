#!/usr/bin/env node

const yargs = require("yargs");
const path = require("path");
const { scrapePage, scrapePages } = require("./scraper");

yargs
  .command(
    "$0 <urls..>",
    "Scrape one or more web pages and extract HTML, CSS, and JS",
    (y) => {
      y.positional("urls", {
        describe: "URL(s) to scrape",
        type: "string",
      });
      y.option("output", {
        alias: "o",
        describe: "Output directory",
        type: "string",
        default: "./scraped",
      });
      y.option("keep-original", {
        alias: "k",
        describe:
          "Keep original <style>/<script> tags in the HTML instead of extracting them",
        type: "boolean",
        default: false,
      });
      y.option("timeout", {
        alias: "t",
        describe: "Navigation timeout in milliseconds",
        type: "number",
        default: 30000,
      });
    },
    async (argv) => {
      const outputDir = path.resolve(argv.output);
      const options = {
        keepOriginalHtml: argv["keep-original"],
        timeout: argv.timeout,
      };

      console.log(`\nWeb Scraper — extracting HTML, CSS, JS`);
      console.log(`Output directory: ${outputDir}\n`);

      if (argv.urls.length === 1) {
        await scrapePage(argv.urls[0], outputDir, options);
      } else {
        await scrapePages(argv.urls, outputDir, options);
      }

      console.log("\nAll done!");
    }
  )
  .example(
    "$0 https://example.com",
    "Scrape a single page into ./scraped/"
  )
  .example(
    "$0 https://example.com https://example.com/about -o ./output",
    "Scrape multiple pages into ./output/"
  )
  .example(
    "$0 https://example.com -k",
    "Scrape but keep styles/scripts inline in the HTML"
  )
  .strict()
  .help()
  .parse();
