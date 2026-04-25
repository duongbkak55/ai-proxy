/**
 * Browser-bundle entry. Exposes the small DLP API the demo page needs.
 * SQL/AST lanes are intentionally excluded (they require native bindings).
 */

import {
  compilePatterns,
  redactAnthropicRequest,
  detokenize,
  type AnthropicRequestBody,
  type DlpRawPattern,
} from "../../src/dlp.js";
import { InProcessTokenVault } from "../../src/vault.js";
import { Dictionary, type DictionaryEntry } from "../../src/dictionary.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).AiProxyDemo = {
  compilePatterns,
  redactAnthropicRequest,
  detokenize,
  InProcessTokenVault,
  Dictionary,
};

export type {
  AnthropicRequestBody,
  DlpRawPattern,
  DictionaryEntry,
};
