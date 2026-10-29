import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createChatHistoryRecoveryProjection,
  projectChatDisplayMessage,
  projectChatDisplayMessages,
} from "./chat-display-projection.core.js";

function history(ok: boolean | undefined): Array<Record<string, unknown>> {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "message",
          arguments: {
            action: "send",
            channel: "slack",
            target: "channel:C123",
            message: "Unverified argument",
          },
        },
      ],
    },
    {
      role: "toolResult",
      toolName: "message",
      toolCallId: "call-1",
      content: ok === undefined ? { messageId: "id" } : { ok, messageId: "id" },
      details: {
        ...(ok === undefined ? {} : { ok }),
        messageId: "id",
        sourceReplyRoute: "current-source",
      },
    },
    { role: "assistant", content: [{ type: "text", text: "NO_REPLY" }] },
  ];
}
function visibleText(messages: unknown[]): string[] {
  return projectChatDisplayMessages(messages).flatMap((message) =>
    message.role === "assistant" && Array.isArray(message.content)
      ? message.content.flatMap((block) =>
          block &&
          typeof block === "object" &&
          block.type === "text" &&
          typeof block.text === "string"
            ? [block.text]
            : [],
        )
      : [],
  );
}
describe("message tool visible delivery compatibility", () => {
  it.each([true, false, undefined])(
    "does not synthesize publication from arguments and result (%s)",
    (ok) => {
      expect(visibleText(history(ok))).not.toContain("Unverified argument");
    },
  );
  it("retains an actual legacy markerless delivery mirror once across reprojection", () => {
    const legacy = {
      role: "assistant",
      provider: "openclaw",
      model: "delivery-mirror",
      content: [{ type: "text", text: "Persisted delivery" }],
    };
    const projected = projectChatDisplayMessages([...history(true), legacy]);
    expect(visibleText([...history(true), legacy])).toEqual(["Persisted delivery"]);
    expect(visibleText(projected)).toEqual(["Persisted delivery"]);
  });
  it("does not collapse independent persisted deliveries with equal text", () => {
    const delivery = {
      role: "assistant",
      provider: "openclaw",
      model: "delivery-mirror",
      content: [{ type: "text", text: "Same text" }],
    };
    expect(visibleText([delivery, { ...delivery }])).toEqual(["Same text", "Same text"]);
  });
  it("drops retired argument-derived synthetic mirrors", () => {
    const synthetic = {
      role: "assistant",
      content: [{ type: "text", text: "Unverified argument" }],
      openclawMessageToolMirror: { toolName: "message", toolCallId: "call-1" },
    };
    expect(visibleText([...history(true), synthetic])).not.toContain("Unverified argument");
  });
  it.each([
    { ok: false },
    { error: "delivery failed" },
    { dryRun: true },
    { suppressed: true },
    { kind: "broadcast", results: [{ ok: true }, { ok: false }] },
    { ok: true, sourceReplyRoute: "other-source" },
  ])("does not construct publication from result %j", (result) => {
    const rows = history(undefined);
    rows[1] = { ...rows[1], content: result, details: result };
    expect(visibleText(rows)).not.toContain("Unverified argument");
  });
  it("keeps the stored publication across split recovery and single-message projection", () => {
    const stored = {
      role: "assistant",
      provider: "openclaw",
      model: "delivery-mirror",
      content: [{ type: "text", text: "Actual external publication" }],
      openclawDisplayContent: [{ type: "text", text: "Actual external publication" }],
      __openclaw: { id: "legacy-entry" },
    };
    const input = [...history(false), stored];
    const before = JSON.stringify(input);
    const recovery = createChatHistoryRecoveryProjection();
    recovery.append(input.slice(0, 2));
    recovery.append(input.slice(2));
    expect(visibleText(recovery.result().messages)).toEqual(["Actual external publication"]);
    expect(visibleText([projectChatDisplayMessage(stored)])).toEqual([
      "Actual external publication",
    ]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("projects the frozen old private owner output without inferring a caption", () => {
    const legacy = JSON.parse(
      readFileSync("src/gateway/legacy-private-publication.fixture.json", "utf8"),
    );
    expect(legacy).not.toHaveProperty("openclawDeliveryMirror");
    expect(visibleText([...history(true), legacy])).toEqual(["Frozen owner publication"]);
  });

  it("projects the frozen old external mirror without exposing differing tool arguments", () => {
    const legacy = JSON.parse(
      readFileSync("src/gateway/legacy-external-publication.fixture.json", "utf8"),
    );
    expect(legacy).not.toHaveProperty("openclawDeliveryMirror");
    expect(visibleText([...history(true), legacy])).toEqual(["Frozen external publication"]);
  });

  it("retains the frozen old private publication text and its managed image reference", () => {
    const legacy = JSON.parse(
      readFileSync("src/gateway/legacy-private-media-publication.fixture.json", "utf8"),
    );
    const projected = projectChatDisplayMessages([legacy]);
    expect(projected).toHaveLength(1);
    expect(projected[0]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "Frozen media publication" }),
        expect.objectContaining({
          type: "image",
          artifactId: expect.stringMatching(/^artifact_managed_image_/),
        }),
      ]),
    );
    expect(projectChatDisplayMessages(projected)).toHaveLength(1);
  });
});
