/**
 * Public API surface for @duongbkak55/ai-proxy.
 * Consumers can either run the bundled CLI (`omc-proxy start`) or
 * import the server programmatically.
 */

export { startProxy } from "./server.js";
export { loadConfig, defaultConfigPath, type ProxyConfig } from "./config.js";
export {
  redactAnthropicRequest,
  type AnthropicRequestBody,
} from "./dlp.js";
