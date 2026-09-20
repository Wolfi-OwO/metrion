// The SPA's browser always sends `Origin` on a non-GET; the tests' bare
// `fetch` does not, and `middlewares/same-origin.ts` refuses that. Adding the
// header here keeps ~45 call sites unchanged. same-origin.test.ts does not
// import this - it tests the missing-header case on purpose.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return realFetch(input, init);
  const headers = new Headers(init?.headers);
  if (!headers.has('origin')) headers.set('origin', 'https://viewer.example.test');
  return realFetch(input, { ...init, headers });
};
