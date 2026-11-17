// pdf.js ships no types for the worker module; it is only loaded to run pdf.js without a worker thread
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
