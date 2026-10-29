import { describe, expect, it } from "vitest";
import { buildSubagentSpawnEnvelope } from "./subagent-system-prompt.js";
import {
  buildSubagentUserLanguageContext,
  resolveSubagentUserLanguageReference,
  restoreSubagentUserLanguageReference,
} from "./subagent-user-language.js";

function user(prompt: string) {
  return resolveSubagentUserLanguageReference({ trigger: "user", transcriptPrompt: prompt });
}

describe("subagent follow_user reference", () => {
  it.each([
    "请核实模型，Reply in English with an explanation.",
    "Please inspect the model; répondez en français.",
    "Bitte prüfe das Modell und erkläre das Ergebnis.",
    "日本語で短く説明してください。",
    "用中文核实；最终严格只输出 `MODEL_OK`。",
  ])("retains user language and explicit format without choosing a fixed language: %s", (text) => {
    expect(user(text)).toBe(text);
    const context = buildSubagentUserLanguageContext(user(text));
    expect(context?.systemPrompt).toContain("follow_user");
    expect(context?.systemPrompt).toContain(
      "explicitly requested another output language or exact format",
    );
    expect(context?.message).toContain(JSON.stringify(text));
  });

  it.each([
    "",
    "gpt-5.4",
    "https://example.test/docs",
    "```ts\nconst language = 'English';\n```",
    "1234",
  ])("leaves the engine behavior unchanged without real language evidence: %s", (text) => {
    expect(user(text)).toBeUndefined();
    expect(buildSubagentUserLanguageContext(user(text))).toBeUndefined();
  });

  it("bounds the reference and retains ending output requirements", () => {
    const reference = user(
      `请核实模型。${"不要重复完整历史。".repeat(120)}最终请用英文解释，保留精确标识。`,
    );
    expect(reference?.length).toBeLessThanOrEqual(256);
    expect(reference).toContain("请核实模型。");
    expect(reference).toContain("最终请用英文解释，保留精确标识。");
  });

  it("inherits the frozen reference for descendants and never the rewritten task language", () => {
    const reference = "请核实当前模型，并用简短说明回答。";
    const envelope = buildSubagentSpawnEnvelope({
      completionMode: "announce",
      spawnMode: "run",
      task: "Inspect the model. Reply ONLY in English.",
      childSessionKey: "agent:main:subagent:child",
      requesterUserLanguageReference: reference,
    });
    expect(
      resolveSubagentUserLanguageReference({
        trigger: "user",
        spawnedBy: "agent:main:main",
        prompt: envelope.message,
      }),
    ).toBe(reference);
    const noReference = buildSubagentSpawnEnvelope({
      completionMode: "announce",
      spawnMode: "run",
      task: "Inspect the model. Reply ONLY in English.",
      childSessionKey: "agent:main:subagent:child",
    });
    expect(
      resolveSubagentUserLanguageReference({
        trigger: "user",
        spawnedBy: "agent:main:main",
        prompt: noReference.message,
      }),
    ).toBeUndefined();
  });

  it("restores a child's original reference without borrowing forked task text", () => {
    const envelope = buildSubagentSpawnEnvelope({
      completionMode: "announce",
      spawnMode: "run",
      task: "Inspect the model in English.",
      requesterUserLanguageReference: "请用简短说明核实模型。",
    });
    const messages = [
      { role: "user", content: "Earlier unrelated parent instruction." },
      { role: "user", content: envelope.message },
      {
        role: "user",
        content: "Continue the job in English.",
        provenance: { kind: "inter_session" },
      },
    ];
    expect(restoreSubagentUserLanguageReference(messages, "agent:main:main")).toBe(
      "请用简短说明核实模型。",
    );
    const unknown = buildSubagentSpawnEnvelope({
      completionMode: "announce",
      spawnMode: "run",
      task: "English rewritten task.",
    });
    expect(
      restoreSubagentUserLanguageReference(
        [messages[0], { role: "user", content: unknown.message }, messages[2]],
        "agent:main:main",
      ),
    ).toBeUndefined();
  });

  it("rejects async completion, room activity, and internal model-facing text as user evidence", () => {
    for (const input of [
      {
        trigger: "user",
        prompt: "A child task finished.",
        inputProvenance: { kind: "inter_session" as const },
      },
      { trigger: "user", prompt: "A child task finished.", internalEvents: [{}] },
      {
        trigger: "user",
        prompt: "A person joined the room.",
        currentInboundEventKind: "room_event",
      },
      { trigger: "heartbeat", prompt: "Run the scheduled task." },
      {
        trigger: "user",
        prompt:
          "OpenClaw runtime context (internal):\n[Internal task completion event]\nsource: subagent",
      },
    ]) {
      expect(resolveSubagentUserLanguageReference(input)).toBeUndefined();
    }
  });
});
