/** Reading zip archives with zip-bomb guards (bytes in, bytes out; no file system access). */
import JSZip from 'jszip';

type ZipStream = {
  on(ev: 'data', cb: (chunk: Uint8Array) => void): ZipStream;
  on(ev: 'error', cb: (e: Error) => void): ZipStream;
  on(ev: 'end', cb: () => void): ZipStream;
  pause(): ZipStream;
  resume(): ZipStream;
};

export class ZipLimitError extends Error {}

/**
 * Entries whose name matches `filter`, inflated as streams: stops as soon as the total exceeds
 * `maxBytes` (the declared sizes can be forged), refuses more than `maxEntries` entries.
 */
export async function readZipEntries(data: Uint8Array, filter: RegExp, maxEntries: number, maxBytes: number): Promise<{ name: string; data: Uint8Array }[]> {
  const zip = await JSZip.loadAsync(data);
  const entries = Object.values(zip.files)
    .filter((f) => !f.dir && filter.test(f.name))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  if (entries.length > maxEntries) throw new ZipLimitError(`Archiv obsahuje ${entries.length} souborů – víc, než je u exportu možné.`);
  let total = 0;
  const out: { name: string; data: Uint8Array }[] = [];
  for (const f of entries) {
    const declared = (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    if (total + declared > maxBytes) throw new ZipLimitError('Archiv je po rozbalení příliš velký.');
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      // internalStream exists at runtime but is missing in the JSZip typings
      const stream = (f as unknown as { internalStream(type: 'uint8array'): ZipStream }).internalStream('uint8array');
      stream
        .on('data', (chunk: Uint8Array) => {
          total += chunk.byteLength;
          if (total > maxBytes) {
            stream.pause();
            reject(new ZipLimitError('Archiv je po rozbalení příliš velký.'));
            return;
          }
          chunks.push(chunk);
        })
        .on('error', (e: Error) => reject(e))
        .on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))))
        .resume();
    });
    out.push({ name: f.name.split(/[\\/]/).pop() ?? f.name, data: bytes });
  }
  return out;
}
