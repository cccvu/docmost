// #626 test fixture: a worker that speaks content-parse.worker.ts's protocol, with behavior chosen by the request's
// content, so the pool's bounds can be tested without loading the real parsers. Started with `workerData.mode`:
//   'never-ready' never posts ready; 'throw-on-load' throws while loading; 'slow-ready:<ms>' posts ready after <ms>
//   (a replacement worker that takes a while to load); anything else posts ready at once.
const { parentPort, workerData } = require('node:worker_threads');

if (workerData && workerData.mode === 'throw-on-load') throw new Error('fixture: failed to load');

/**
 * #734: call `done` once at least `ms` have passed on the monotonic clock (`performance.now()`), the clock the pool
 * charges with. A bare setTimeout(ms) can fire about 1 ms early (libuv starts the timer from its cached, ms-truncated
 * loop time), so a 60 ms sleep was sometimes charged 59 and the "charged at least <ms>" specs flaked. The pool's own
 * clock starts before it posts the request, so ending at or after `until` makes the conversion it measures ≥ `ms`.
 */
function sleepAtLeast(ms, done) {
  const until = performance.now() + ms;
  const check = () => {
    const left = Math.ceil(until - performance.now());
    if (left > 0) setTimeout(check, left);
    else done();
  };
  setTimeout(check, ms);
}

parentPort.on('message', (req) => {
  const reply = (r) => parentPort.postMessage({ id: req.id, ...r });
  // #716: a `serialize` request carries its script in `json.script` (it has no `content`).
  const content = String(req.op === 'serialize' ? req.json && req.json.script : req.content);
  // 'hang:<padding>' (#716): the same, with an input long enough to be classed large.
  if (content === 'hang' || content.startsWith('hang:')) for (;;); // a synchronous parse that never ends
  if (content === 'oom') {
    const hoard = [];
    for (;;) hoard.push(new Array(1e6).fill(Math.random()));
  }
  if (content === 'crash') process.exit(3);
  if (content === 'invalid') return reply({ ok: false, reason: 'invalid' });
  if (content === 'too-complex') return reply({ ok: false, reason: 'too_complex', detail: 'nodes' });
  const sleep = /^sleep:(\d+)(?::(.*))?$/.exec(content);
  if (sleep) {
    const label = sleep[2] ?? '';
    const result = req.op === 'serialize' ? `serialized:${label}` : { type: 'doc', label };
    return sleepAtLeast(Number(sleep[1]), () => reply({ ok: true, result, nodes: 1 }));
  }
  if (req.op === 'markdown-to-html') {
    const html = `<p>${content}</p>`;
    // As the real worker: the HTML may not be longer than the request's cap.
    if (html.length > req.maxChars) return reply({ ok: false, reason: 'too_complex', detail: 'chars' });
    return reply({ ok: true, result: html });
  }
  reply({ ok: true, result: { type: 'doc', label: content }, nodes: 1 });
});

const slow = /^slow-ready:(\d+)$/.exec((workerData && workerData.mode) || '');
if (slow) setTimeout(() => parentPort.postMessage({ ready: true }), Number(slow[1]));
else if (!(workerData && workerData.mode === 'never-ready')) parentPort.postMessage({ ready: true });
