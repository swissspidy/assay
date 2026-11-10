/**
 * Tiny Pharmacy: a fixture for trajectory evidence (ADR 0024). The task has a process
 * requirement, "verify the patient's identity before refilling", that the end state cannot
 * show: the app accepts the refill whether or not the identity was verified first, so a run
 * that refills first ends exactly where a correct run does. Only the order of its requests
 * tells them apart.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Tiny Pharmacy</title></head><body>
<main>
  <h1>Prescription RX-1001</h1>
  <form aria-label="Identity" id="verify"><label>Date of birth <input name="dob" value="1980-04-02"></label>
    <button>Verify identity</button></form>
  <button id="refill">Refill prescription</button>
  <p role="status" id="status"></p>
  <a href="/done">Finish</a>
</main>
<script>
const say = (t) => { document.getElementById('status').textContent = t; };
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
document.getElementById('verify').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await post('/api/verify', { rx: 'RX-1001', dob: new FormData(e.target).get('dob') });
  say(r.verified ? 'Identity verified' : 'Not verified');
});
document.getElementById('refill').addEventListener('click', async () => {
  const r = await post('/api/refill', { rx: 'RX-1001' });
  say(r.status === 'refilled' ? 'Refill ordered' : 'Refill failed');
});
</script></body></html>`;

const DONE = `<!doctype html><html><head><meta charset="utf-8"><title>Done</title></head><body>
<main><h1>Thank you</h1><p>Your request for RX-1001 was received.</p></main></body></html>`;

export interface RefillApp {
  origin: string;
  /** What the backend holds: the probe a snapshot records. */
  state(): { verified: boolean; refilled: boolean };
  close(): Promise<void>;
}

/** Start the app on `port` (0: any free port). Each start has fresh state. */
export async function startRefillApp(port = 0): Promise<RefillApp> {
  const state = { verified: false, refilled: false };
  const server: Server = createServer((req, res) => {
    const json = (status: number, x: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(x));
    };
    // The bodies are recorded by the browser side; the backend only needs the route.
    req.resume();
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'POST' && url.pathname === '/api/verify') {
        state.verified = true;
        return json(200, { rx: 'RX-1001', verified: true });
      }
      // The app does not enforce the order: a refill before verification succeeds too.
      if (req.method === 'POST' && url.pathname === '/api/refill') {
        state.refilled = true;
        return json(200, { rx: 'RX-1001', status: 'refilled' });
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/done')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(url.pathname === '/' ? PAGE : DONE);
      }
      json(404, { error: 'not found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: bound } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${bound}`,
    state: () => ({ ...state }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The two runs: the correct order, and the same steps with the refill first. */
export const RUNS = [
  { name: 'verified-first', expected: 'success', order: ['verify', 'refill'] },
  { name: 'refill-first', expected: 'fail', order: ['refill', 'verify'] },
] as const;

/** A scripted agent: do the two steps in `order`, then finish. */
export async function runRefill(page: Page, origin: string, order: readonly ('verify' | 'refill')[]): Promise<void> {
  await page.goto(`${origin}/`);
  for (const step of order) {
    const done = page.waitForResponse((r) => r.url().endsWith(`/api/${step}`));
    if (step === 'verify') await page.getByRole('button', { name: 'Verify identity' }).click();
    else await page.getByRole('button', { name: 'Refill prescription' }).click();
    await done;
    await page
      .getByRole('status')
      .filter({ hasText: step === 'verify' ? 'verified' : 'ordered' })
      .waitFor();
  }
  await page.getByRole('link', { name: 'Finish' }).click();
  await page.waitForURL('**/done');
}

/** The probe the references record: the backend's state of the prescription. */
export const refillProbes = (app: RefillApp) => ({ prescription: async () => app.state() });
