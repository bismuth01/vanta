// In-browser Solidity compiler (classic worker: soljson must compile its wasm synchronously,
// which browsers only allow off the main thread). Strategy source never leaves the browser.
let compile = null

self.onmessage = (e) => {
  const { id, version, input } = e.data
  try {
    if (!compile) {
      importScripts(`https://binaries.soliditylang.org/bin/${version}`)
      compile = self.Module.cwrap('solidity_compile', 'string', ['string', 'number', 'number'])
    }
    const output = JSON.parse(compile(JSON.stringify(input), 0, 0))
    self.postMessage({ id, output })
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message ? err.message : err) })
  }
}
