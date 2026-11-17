/**
 * Positioned text of a PDF (bytes in, text items out) via Mozilla pdf.js. No file system or network
 * access: the document is given as bytes, fonts are not loaded (only the text is needed) and
 * scripting/eval is disabled.
 */
import type { PdfPage } from './rbPdf.js';

/** Statements have a few pages; anything far longer is not a statement. */
const MAX_PAGES = 200;
/** guards the (same-thread) parse against text-heavy documents */
const MAX_ITEMS = 200_000;

let pdfjsPromise: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null;

function loadPdfjs() {
  pdfjsPromise ??= (async () => {
    // run pdf.js in this thread: no worker file has to be located at runtime (bundles, Electron)
    const worker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '';
    return pdfjs;
  })();
  pdfjsPromise.catch(() => {
    pdfjsPromise = null;
  });
  return pdfjsPromise;
}

export function isPdf(data: Uint8Array): boolean {
  return data.length > 4 && data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46; // %PDF
}

export async function pdfPages(data: Uint8Array): Promise<PdfPage[]> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(data), // pdf.js takes ownership of the buffer
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    disableAutoFetch: true,
    disableStream: true,
    stopAtErrors: false,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    if (doc.numPages > MAX_PAGES) throw new Error(`PDF má ${doc.numPages} stran – nejde o výpis z účtu.`);
    const pages: PdfPage[] = [];
    let count = 0;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const items: PdfPage = [];
      for (const it of tc.items) {
        if (!('str' in it) || !it.str.trim()) continue;
        items.push({ x: Math.round(it.transform[4] * 10) / 10, y: Math.round(it.transform[5] * 10) / 10, w: Math.round(it.width * 10) / 10, s: it.str });
      }
      count += items.length;
      if (count > MAX_ITEMS) throw new Error('PDF obsahuje příliš mnoho textu – nejde o výpis z účtu.');
      pages.push(items);
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
