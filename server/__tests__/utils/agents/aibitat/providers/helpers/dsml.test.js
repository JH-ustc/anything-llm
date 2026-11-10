const {
  DsmlStreamFilter,
  extractDsmlToolCalls,
  stripDsml,
} = require("../../../../../../utils/agents/aibitat/providers/helpers/dsml.js");
const {
  tooledStream,
  tooledComplete,
} = require("../../../../../../utils/agents/aibitat/providers/helpers/tooled.js");

const DSML_SAMPLE = `I'll do one combined search maybe two.
</think><｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="rag-memory">
<｜｜DSML｜｜ parameter name="action" string="true">search</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="content" string="true">复变函数 考点权重表</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
<｜｜DSML｜｜ invoke name="rag-memory">
<｜｜DSML｜｜ parameter name="action" string="true">search</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="content" string="true">复变函数 级数</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;

const FUNCTIONS = [
  {
    name: "rag-memory",
    description: "Search long-term memory cards",
    parameters: { type: "object", properties: {} },
  },
];

function chunkString(value, size) {
  const chunks = [];
  for (let i = 0; i < value.length; i += size) {
    chunks.push(value.slice(i, i + size));
  }
  return chunks;
}

describe("extractDsmlToolCalls", () => {
  it("recovers parallel calls from a malformed calls wrapper", () => {
    const result = extractDsmlToolCalls(DSML_SAMPLE);

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]).toEqual({
      name: "rag-memory",
      arguments: { action: "search", content: "复变函数 考点权重表" },
    });
    expect(result.toolCalls[1]).toEqual({
      name: "rag-memory",
      arguments: { action: "search", content: "复变函数 级数" },
    });
    expect(result.text).toContain("I'll do one combined search maybe two.");
    expect(result.text).not.toContain("DSML");
  });

  it("supports single-bar and ASCII marker variants", () => {
    const singleBar = `<｜DSML｜ invoke name="lookup"><｜DSML｜ parameter name="query" string="true">abc</｜DSML｜ parameter></｜DSML｜ invoke>`;
    const asciiBar = `<|DSML|invoke name="lookup"><|DSML|parameter name="query" string="true">abc</|DSML|parameter></|DSML|invoke>`;

    expect(extractDsmlToolCalls(singleBar).toolCalls[0]).toEqual({
      name: "lookup",
      arguments: { query: "abc" },
    });
    expect(extractDsmlToolCalls(asciiBar).toolCalls[0]).toEqual({
      name: "lookup",
      arguments: { query: "abc" },
    });
  });

  it("parses non-string parameters as JSON", () => {
    const payload = `<｜｜DSML｜｜ invoke name="lookup"><｜｜DSML｜｜ parameter name="limit" string="false">5</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>`;
    expect(extractDsmlToolCalls(payload).toolCalls[0].arguments).toEqual({
      limit: 5,
    });
  });

  it("leaves ordinary text untouched", () => {
    const text = "普通回答，没有工具调用。";
    expect(extractDsmlToolCalls(text)).toEqual({ toolCalls: [], text });
  });
});

describe("stripDsml", () => {
  it("removes every marker but keeps surrounding text", () => {
    const cleaned = stripDsml(
      `before <｜｜DSML｜｜ calls>mid</｜｜DSML｜｜ calls> after`
    );
    expect(cleaned).toBe("before  after");
  });

  it("returns an empty string for non-string input", () => {
    expect(stripDsml(null)).toBe("");
  });
});

describe("DsmlStreamFilter", () => {
  it("never forwards markup, even when split across chunks", () => {
    const filter = new DsmlStreamFilter();
    let visible = "";
    for (const chunk of chunkString(DSML_SAMPLE, 7)) {
      visible += filter.push(chunk);
    }
    visible += filter.flush();

    expect(visible).toContain("I'll do one combined search maybe two.");
    expect(visible).not.toContain("DSML");
    expect(visible).not.toContain("rag-memory");
  });

  it("flushes normal text immediately", () => {
    const filter = new DsmlStreamFilter();
    expect(filter.push("hello ")).toBe("hello ");
    expect(filter.push("world")).toBe("world");
    expect(filter.flush()).toBe("");
  });

  it("holds a partial marker until the next chunk decides", () => {
    const filter = new DsmlStreamFilter();
    expect(filter.push("answer <")).toBe("answer ");
    expect(filter.push("1")).toBe("<1");
    expect(filter.flush()).toBe("");
  });
});

describe("native tooled path DSML recovery", () => {
  it("tooledStream recovers the call and hides the markup", async () => {
    const chunks = chunkString(DSML_SAMPLE, 11);
    const create = jest.fn(async () =>
      (async function* () {
        for (const chunk of chunks) {
          yield { choices: [{ delta: { content: chunk } }] };
        }
      })()
    );
    const client = { chat: { completions: { create } } };
    const emitted = [];
    const eventHandler = (name, payload) => {
      if (name === "reportStreamEvent" && payload?.type === "textResponseChunk") {
        emitted.push(payload.content);
      }
    };

    const result = await tooledStream(
      client,
      "deepseek-flash",
      [{ role: "user", content: "hi" }],
      FUNCTIONS,
      eventHandler,
      { provider: {} }
    );

    expect(result.functionCall).toEqual(
      expect.objectContaining({
        name: "rag-memory",
        arguments: { action: "search", content: "复变函数 考点权重表" },
      })
    );
    expect(result.textResponse).not.toContain("DSML");
    expect(emitted.join("")).not.toContain("DSML");
    expect(emitted.join("")).not.toContain("rag-memory");
  });

  it("tooledComplete recovers the call", async () => {
    const create = jest.fn(async () => ({
      choices: [{ message: { role: "assistant", content: DSML_SAMPLE } }],
      usage: null,
    }));
    const client = { chat: { completions: { create } } };

    const result = await tooledComplete(
      client,
      "deepseek-flash",
      [{ role: "user", content: "hi" }],
      FUNCTIONS,
      () => 0,
      { provider: {} }
    );

    expect(result.functionCall).toEqual(
      expect.objectContaining({
        name: "rag-memory",
        arguments: { action: "search", content: "复变函数 考点权重表" },
      })
    );
    expect(result.textResponse).toBeNull();
  });
});
