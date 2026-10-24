import { spawn } from 'node:child_process';
import { createServer } from './app.js';

const port = Number(process.env.PORT ?? 5174);
const { start } = await createServer();
const url = await start(port);
console.log(`Myfin běží na ${url}  (ukončení: Ctrl+C)`);
if (process.argv.includes('--open')) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd[0] as string, cmd[1] as string[], { detached: true, stdio: 'ignore' }).unref();
}
