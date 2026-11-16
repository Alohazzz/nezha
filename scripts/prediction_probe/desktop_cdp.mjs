// Own isolated WebView2 CDP only. No browser internals or user profile access.
import { writeFile } from 'node:fs/promises';

export async function connect(port = 9222) {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
  const target = targets.find(t => t.type === 'page' && /localhost:1420/.test(t.url));
  if (!target) throw new Error('Isolated Nezha page is not ready');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const entry = pending.get(message.id);
    if (entry) { pending.delete(message.id); message.error ? entry.reject(message.error) : entry.resolve(message.result); }
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    call,
    async evaluate(expression) {
      const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    },
    async screenshot(path) {
      const result = await call('Page.captureScreenshot', { format: 'png' });
      await writeFile(path, Buffer.from(result.data, 'base64'));
    },
    close() { socket.close(); },
  };
}

if (process.argv[1]?.endsWith('desktop_cdp.mjs')) {
  const cdp = await connect(Number(process.env.NEZHA_CDP_PORT || 9222));
  try { console.log(JSON.stringify(await cdp.evaluate(process.argv[2]), null, 2)); }
  finally { cdp.close(); }
}
