import { createReadStream, existsSync, statSync, watch } from 'node:fs';
import { logFile } from '../paths';
import { colour, info } from '../output';

/**
 * Print (or follow) the daemon log.
 *
 * `-n N` prints the last N lines, defaulting to 100 to match the old
 * `npm run node:logs`. `-f` then streams whatever is appended, and re-opens the
 * file from offset 0 when rotation truncates it in place.
 */
export async function runLogs(lines: number, follow: boolean): Promise<void> {
  const path = logFile();

  if (!existsSync(path)) {
    info(`No log file yet at ${path}.`);
    info(colour.dim('  Start the node with `diiisco start` to create one.'));
    if (!follow) {
      process.exitCode = 1;
      return;
    }
  }

  let offset = 0;
  if (existsSync(path)) {
    const tail = await readTail(path, lines);
    offset = tail.size;
    if (tail.text !== '') process.stdout.write(tail.text.endsWith('\n') ? tail.text : `${tail.text}\n`);
  }

  if (!follow) return;

  await new Promise<void>(() => {
    let reading = false;

    const drain = async () => {
      if (reading) return;
      reading = true;
      try {
        if (!existsSync(path)) return;
        const size = statSync(path).size;
        // Rotation truncates the file in place, so a shrinking file means the
        // log restarted rather than that we lost our place.
        if (size < offset) offset = 0;
        if (size === offset) return;
        const chunk = await readRange(path, offset, size - 1);
        offset = size;
        process.stdout.write(chunk);
      } catch {
        // Transient read error while the daemon writes — try again next tick.
      } finally {
        reading = false;
      }
    };

    try {
      watch(path, () => void drain());
    } catch {
      // Some filesystems have no watch support; the interval below covers it.
    }
    setInterval(() => void drain(), 1000);
  });
}

async function readTail(path: string, lines: number): Promise<{ text: string; size: number }> {
  const size = statSync(path).size;
  if (size === 0 || lines <= 0) return { text: '', size };

  // Read from the end in growing chunks until enough newlines are in hand; a
  // multi-megabyte log must not be loaded into memory to show 100 lines.
  let chunkSize = Math.min(size, 64 * 1024);
  for (;;) {
    const start = Math.max(0, size - chunkSize);
    const text = await readRange(path, start, size - 1);
    const found = text.split('\n');
    const complete = start === 0 ? found : found.slice(1);
    if (complete.length > lines || start === 0 || chunkSize >= 8 * 1024 * 1024) {
      const wanted = complete.slice(Math.max(0, complete.length - lines - (complete[complete.length - 1] === '' ? 1 : 0)));
      return { text: wanted.join('\n'), size };
    }
    chunkSize = Math.min(size, chunkSize * 4);
  }
}

function readRange(path: string, start: number, end: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(path, { start, end });
    stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
