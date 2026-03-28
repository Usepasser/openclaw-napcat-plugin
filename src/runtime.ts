// Global runtime reference for the plugin
let _runtime: any;
let _config: any = {};
let _ws: any = null;

export function setNapCatRuntime(runtime: any) {
  _runtime = runtime;
}

export function setNapCatConfig(config: any) {
  _config = config;
}

export function setNapCatWs(ws: any) {
  _ws = ws;
}

export function getNapCatWs() {
  return _ws;
}

export function getNapCatRuntime() {
  if (!_runtime) {
    throw new Error("NapCat runtime not initialized");
  }
  return _runtime;
}

export function getNapCatConfig() {
  return _config || {};
}
