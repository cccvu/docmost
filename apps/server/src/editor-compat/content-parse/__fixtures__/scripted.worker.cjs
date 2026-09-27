// #626 test fixture: a worker that speaks content-parse.worker.ts's protocol, with behavior chosen by the request's
// content, so the pool's bounds can be tested without loading the real parsers. Started with `workerData.mode`:
//   'never-ready' never posts ready; 'throw-on-load' throws while loading; anything else posts ready.
const { parentPort, workerData } = require('node:worker_threads');

if (workerData && workerData.mode === 'throw-on-load') throw new Error('fixture: failed to load');

parentPort.on('message', (req) => {
  const reply = (r) => parentPort.postMessage({ id: req.id, ...r });
  const content = String(req.content);
  if (content === 'hang') for (;;); // a synchronous parse that never ends
  if (content === 'oom') {
    const hoard = [];
    for (;;) hoard.push(new Array(1e6).fill(Math.random()));
  }
  if (content === 'crash') process.exit(3);
  if (content === 'invalid') return reply({ ok: false, reason: 'invalid' });
  if (content === 'too-complex') return reply({ ok: false, reason: 'too_complex', detail: 'nodes' });
  const sleep = /^sleep:(\d+)(?::(.*))?$/.exec(content);
  if (sleep) {
    return setTimeout(() => reply({ ok: true, result: { type: 'doc', label: sleep[2] ?? '' }, nodes: 1 }), Number(sleep[1]));
  }
  reply({ ok: true, result: req.op === 'markdown-to-html' ? `<p>${content}</p>` : { type: 'doc', label: content }, nodes: 1 });
});

if (!(workerData && workerData.mode === 'never-ready')) parentPort.postMessage({ ready: true });
