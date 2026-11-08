import { Readable, Writable } from 'node:stream';

// Inject public request/response streams without binding a network port.
export function requestClient(server) {
  let cookie = '';
  return async (path, options = {}) => {
    const req = Readable.from(options.body === undefined ? [] : [Buffer.from(options.body)]);
    req.url = path;
    req.method = options.method || 'GET';
    req.headers = { 'content-type': 'application/json', cookie, host: 'localhost' };
    const chunks = [];
    const headers = {};
    const res = new Writable({ write(chunk, encoding, callback) { chunks.push(chunk); callback(); } });
    res.setHeader = (key, value) => { headers[key.toLowerCase()] = value; };
    res.writeHead = (status, values) => { res.statusCode = status; res.headersSent = true; for (const [key, value] of Object.entries(values)) res.setHeader(key, value); };
    const finished = new Promise((resolve, reject) => { res.on('finish', resolve); res.on('error', reject); });
    server.emit('request', req, res);
    await finished;
    if (headers['set-cookie']) cookie = headers['set-cookie'].split(';')[0];
    const text = Buffer.concat(chunks).toString();
    return { status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, headers, text: async () => text, json: async () => JSON.parse(text) };
  };
}
