// src/contract.ts
var SIDECAR_SCHEMA_VERSION = 1;
function sidecarProducer() {
  return `billion-context-pi@${true ? "0.1.83" : "dev"}`;
}
export {
  SIDECAR_SCHEMA_VERSION,
  sidecarProducer
};
