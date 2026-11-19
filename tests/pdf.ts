/**
 * Renders the CV to PDF, for the build script and the tests, and reads a PDF
 * back so the tests can check what a reader would get.
 *
 * @author John Grimes
 */

import { join } from "node:path";

import type { Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

/** Where the published PDF is kept, beside the page it is made from. */
export const PDF_PATH = join(__dirname, "..", "john-grimes-cv.pdf");

/** A run of text in a PDF page, placed by the left end of its baseline. */
export type PdfText = {
  str: string;
  /** Points from the left edge of the page. */
  x: number;
  /** Points from the bottom edge of the page. */
  y: number;
};

/** One page of a PDF. */
export type PdfPage = {
  /** Width in points. */
  width: number;
  /** Height in points. */
  height: number;
  /** Text in the order the file holds it, which is the order a program
   *  reading the PDF receives it. */
  items: PdfText[];
  /** Addresses of the links on the page. */
  links: string[];
};

/** What a PDF file holds, as far as the tests are concerned. */
export type PdfContent = {
  /** The document properties, such as Title and Author. */
  info: Record<string, unknown>;
  /** Whether the file is tagged with its structure for assistive technology. */
  tagged: boolean;
  /** Every font the file uses. */
  fonts: { name: string; type3: boolean; embedded: boolean }[];
  pages: PdfPage[];
};

/**
 * Reduces text to the characters that the page and its PDF have in common, so
 * the two can be compared. White space goes, because the lines of the two
 * break in different places. En dashes go too, because the PDF holds the
 * bullet markers and the text of the page does not.
 *
 * @param text - Text from the page or from the PDF.
 * @returns The text without white space or en dashes.
 * @example
 * flatten("2018 – present\n– Encodes FHIR"); // "2018presentEncodesFHIR"
 */
export const flatten = (text: string) => text.replace(/[\s–]/g, "");

/**
 * Renders the loaded CV page to PDF, as printing it from the browser would,
 * and records the page's author and description in the document properties.
 *
 * @param page - The Playwright page, with the CV already loaded.
 * @returns The bytes of the PDF file.
 * @throws If the page does not name its author and description in `meta`
 *   elements, or the browser fails to print it.
 * @example
 * await page.goto("/");
 * await writeFile(PDF_PATH, await renderPdf(page));
 */
export const renderPdf = async (page: Page): Promise<Uint8Array> => {
  await page.evaluate(() => document.fonts.ready);
  const printed = await page.pdf({
    // The stylesheet's @page rule decides the size, as it does when printing
    // from the browser.
    preferCSSPageSize: true,
    printBackground: true,
    // Records headings, lists and links for assistive technology.
    tagged: true,
  });
  // The browser records the page's title and language, but not who wrote it
  // or what it is about.
  const [author, subject] = await Promise.all(
    ["author", "description"].map((name) =>
      page.locator(`meta[name='${name}']`).getAttribute("content"),
    ),
  );
  if (!author || !subject) {
    throw new Error("The page has an empty author or description");
  }
  const pdf = await PDFDocument.load(printed, { updateMetadata: false });
  pdf.setAuthor(author);
  pdf.setSubject(subject);
  return pdf.save();
};

/**
 * Reads the properties, fonts, text and links of a PDF file.
 *
 * @param data - The bytes of the PDF file.
 * @returns The content of the file, page by page.
 * @throws If the bytes are not a readable PDF.
 * @example
 * const { pages } = await readPdf(await readFile(PDF_PATH));
 * console.log(pages.length, pages[0].items[0].str);
 */
export const readPdf = async (data: Uint8Array): Promise<PdfContent> => {
  // pdf.js takes ownership of the bytes it is given, so hand it a copy.
  const pdf = await getDocument({
    data: new Uint8Array(data),
    fontExtraProperties: true,
    verbosity: 0,
  }).promise;
  const { info } = await pdf.getMetadata();
  const fonts = new Map<string, PdfContent["fonts"][number]>();
  const pages: PdfPage[] = [];
  let tagged = true;
  for (let n = 1; n <= pdf.numPages; n++) {
    const p = await pdf.getPage(n);
    const { width, height } = p.getViewport({ scale: 1 });
    const { items } = await p.getTextContent();
    const annotations = await p.getAnnotations();
    tagged &&= !!(await p.getStructTree());
    // Fonts are only loaded once the page's drawing instructions are read.
    const { fnArray, argsArray } = await p.getOperatorList();
    fnArray.forEach((fn, i) => {
      if (fn !== OPS.setFont) return;
      const font = p.commonObjs.get(argsArray[i][0]);
      fonts.set(font.name, {
        name: font.name,
        type3: font.isType3Font,
        embedded: !font.missingFile,
      });
    });
    pages.push({
      width,
      height,
      items: items.flatMap((item) =>
        "str" in item && item.str.trim()
          ? [{ str: item.str, x: item.transform[4], y: item.transform[5] }]
          : [],
      ),
      links: annotations.flatMap((a) =>
        a.subtype === "Link" && a.url ? [a.url] : [],
      ),
    });
  }
  return {
    info: info as Record<string, unknown>,
    tagged,
    fonts: [...fonts.values()],
    pages,
  };
};
