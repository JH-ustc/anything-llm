/**
 * DeepSeek V4 models can emit tool calls as DSML markup in the assistant
 * message content instead of structured OpenAI `tool_calls` (for example when
 * several calls are issued in parallel or the wrapper tag is malformed).
 * The markup then leaks into the chat as plain text. These helpers recover the
 * calls and remove the markup from visible text.
 *
 * Supported marker variants:
 *   <｜｜DSML｜｜ invoke ...>  (double full-width bar, observed in V4.1 Flash)
 *   <｜DSML｜ invoke ...>     (single full-width bar)
 *   <||DSML|| invoke ...>     (double ASCII bar)
 *   <|DSML| invoke ...>       (single ASCII bar)
 */

const BAR = "[\\uFF5C|]";
const MARK = `${BAR}{1,3}\\s*DSML\\s*${BAR}{1,3}`;
const START_SOURCE = `<${MARK}`;
const INVOKE_SOURCE = `<${MARK}\\s*invoke\\s+name\\s*=\\s*["']([^"']+)["']\\s*>([\\s\\S]*?)</${MARK}\\s*invoke\\s*>`;
const PARAM_SOURCE = `<${MARK}\\s*parameter\\s+name\\s*=\\s*["']([^"']+)["'](?:\\s+string\\s*=\\s*["'](true|false)["'])?\\s*>([\\s\\S]*?)</${MARK}\\s*parameter\\s*>`;
const ANY_TAG_SOURCE = `</?${MARK}\\s*[a-zA-Z_][\\w-]*[^>]*>`;
const CALLS_CLOSE_SOURCE = `</${MARK}\\s*(?:tool_)?calls\\s*>`;
const INVOKE_CLOSE_SOURCE = `</${MARK}\\s*invoke\\s*>`;

const START_RE = new RegExp(START_SOURCE, "i");

// Complete opening markers used to decide whether a chunk suffix might be the
// beginning of a DSML sequence split across stream chunks.
const FULL_START_MARKERS = [
  "<｜｜DSML｜｜",
  "<｜DSML｜",
  "<||DSML||",
  "<|DSML|",
];

function parseParamValue(rawValue, stringFlag) {
  const value = String(rawValue ?? "").trim();
  if (stringFlag === "false") {
    try {
      return JSON.parse(value);
    } catch {
      // Fall through and keep the raw string.
    }
  }
  return value;
}

/**
 * Remove every DSML tag/invocation block from text.
 * @param {string} text
 * @returns {string}
 */
function stripDsml(text = "") {
  if (typeof text !== "string" || text.length === 0) return "";
  return text
    .replace(new RegExp(INVOKE_SOURCE, "gi"), "")
    .replace(new RegExp(PARAM_SOURCE, "gi"), "")
    .replace(new RegExp(ANY_TAG_SOURCE, "gi"), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract tool calls serialized as DSML and return the remaining visible text.
 * @param {string} text
 * @returns {{toolCalls: Array<{name: string, arguments: Object}>, text: string}}
 */
function extractDsmlToolCalls(text = "") {
  if (typeof text !== "string" || text.length === 0) {
    return { toolCalls: [], text: typeof text === "string" ? text : "" };
  }

  const toolCalls = [];
  const invokeRe = new RegExp(INVOKE_SOURCE, "gi");
  let invoke;
  while ((invoke = invokeRe.exec(text)) !== null) {
    const args = {};
    const paramRe = new RegExp(PARAM_SOURCE, "gi");
    let param;
    while ((param = paramRe.exec(invoke[2])) !== null) {
      args[param[1]] = parseParamValue(param[3], param[2]);
    }
    toolCalls.push({ name: invoke[1], arguments: args });
  }

  return { toolCalls, text: stripDsml(text) };
}

/**
 * Streaming filter that withholds DSML markup from the text chunks sent to the
 * client. Anything that is not part of a DSML block is emitted immediately.
 */
class DsmlStreamFilter {
  constructor() {
    this.pending = "";
    this.inDsml = false;
    this.dsml = "";
  }

  /**
   * Feed a content chunk and return the text that is safe to display.
   * @param {string} chunk
   * @returns {string}
   */
  push(chunk) {
    if (typeof chunk !== "string" || chunk.length === 0) return "";

    if (this.inDsml) {
      this.dsml += chunk;
      return this.#drain();
    }

    this.pending += chunk;
    const start = this.pending.search(START_RE);
    if (start !== -1) {
      const visible = this.pending.slice(0, start);
      this.dsml = this.pending.slice(start);
      this.pending = "";
      this.inDsml = true;
      return visible + this.#drain();
    }

    const hold = partialMarkerSuffixLength(this.pending);
    if (hold > 0) {
      const cut = this.pending.length - hold;
      const visible = this.pending.slice(0, cut);
      this.pending = this.pending.slice(cut);
      return visible;
    }

    const visible = this.pending;
    this.pending = "";
    return visible;
  }

  /**
   * Flush any text still held back. An unterminated DSML block is swallowed
   * (it will be recovered from the full response by extractDsmlToolCalls).
   * @returns {string}
   */
  flush() {
    if (this.inDsml) {
      const matches = [
        ...this.dsml.matchAll(new RegExp(INVOKE_CLOSE_SOURCE, "gi")),
      ];
      let rest = "";
      if (matches.length > 0) {
        const last = matches[matches.length - 1];
        rest = this.dsml.slice(last.index + last[0].length);
        if (START_RE.test(rest)) rest = "";
      }
      this.dsml = "";
      this.inDsml = false;
      return rest ? stripDsml(rest) : "";
    }

    const visible = this.pending;
    this.pending = "";
    return visible;
  }

  #drain() {
    const close = this.dsml.match(new RegExp(CALLS_CLOSE_SOURCE, "i"));
    if (!close) return "";

    const end = close.index + close[0].length;
    const rest = this.dsml.slice(end);
    this.dsml = "";
    this.inDsml = false;
    return rest ? this.push(rest) : "";
  }
}

function partialMarkerSuffixLength(text) {
  const max = Math.min(text.length, 16);
  for (let length = max; length >= 1; length--) {
    const suffix = text.slice(-length).toLowerCase();
    if (
      FULL_START_MARKERS.some((marker) =>
        marker.toLowerCase().startsWith(suffix)
      )
    ) {
      return length;
    }
  }
  return 0;
}

module.exports = {
  DsmlStreamFilter,
  extractDsmlToolCalls,
  stripDsml,
};
