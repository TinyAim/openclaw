import { describe, expect, it } from "vitest";
import { buildEmbeddedAttemptToolRunContext } from "./attempt-tool-run-context.js";

describe("buildEmbeddedAttemptToolRunContext", () => {
  it("projects originating capabilities without copying execution or session ownership", () => {
    const input = {
      clientCaps: ["inline-widgets"],
      pinnedWidgetAuthoring: true,
      toolBindings: { browser: { kind: "tab", tabId: 7 } },
      memberRoleIds: ["maintainer-role"],
      approvalReviewerDeviceId: "reviewer-device",
      taskSuggestionDeliveryMode: "gateway" as const,
      chatId: "native-conversation",
      sessionKey: "agent:main:dashboard:current",
      sessionId: "source-session",
      runId: "source-run",
      onYield: () => undefined,
    };
    const context = buildEmbeddedAttemptToolRunContext(input);

    expect(context).toMatchObject({
      clientCaps: ["inline-widgets"],
      pinnedWidgetAuthoring: true,
      toolBindings: input.toolBindings,
      memberRoleIds: ["maintainer-role"],
      approvalReviewerDeviceId: "reviewer-device",
      taskSuggestionDeliveryMode: "gateway",
      nativeChannelId: "native-conversation",
    });
    for (const ownedField of ["sessionKey", "sessionId", "runId", "onYield"]) {
      expect(context).not.toHaveProperty(ownedField);
    }
  });

  it("freezes real user language separately from internal prompt context", () => {
    const input = {
      trigger: "user" as const,
      transcriptPrompt: "请核实当前模型，保留精确模型名。",
      prompt: "Server-only project context in English.",
    };
    const context = buildEmbeddedAttemptToolRunContext(input);
    expect(context.requesterUserLanguageReference).toBe(input.transcriptPrompt);
    input.transcriptPrompt = "Now use English.";
    expect(context.requesterUserLanguageReference).toBe("请核实当前模型，保留精确模型名。");
    expect(
      buildEmbeddedAttemptToolRunContext({
        ...input,
        inputProvenance: { kind: "inter_session", sourceTool: "subagent_announce" },
      }).requesterUserLanguageReference,
    ).toBeUndefined();
  });

  it("restores only prior native user evidence after an internal continuation", () => {
    const context = buildEmbeddedAttemptToolRunContext({
      trigger: "user",
      prompt: "Continue the internal delegated task.",
      inputProvenance: { kind: "inter_session", sourceTool: "sessions_send" },
    });
    expect(context.getRequesterUserLanguageReference()).toBeUndefined();
    context.restoreRequesterUserLanguageReference([
      { role: "user", content: "请按当前需求核实模型。", provenance: { kind: "external_user" } },
      { role: "assistant", content: "English model output is not user input." },
      {
        role: "user",
        content: "The child finished.",
        provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
      },
    ]);
    const frozenForChild = context.getRequesterUserLanguageReference();
    expect(frozenForChild).toBe("请按当前需求核实模型。");
    context.restoreRequesterUserLanguageReference([
      { role: "user", content: "Now answer in English." },
    ]);
    expect(context.getRequesterUserLanguageReference()).toBe(frozenForChild);
  });

  it("carries runtime toolsAllow into coding tool construction", () => {
    const context = buildEmbeddedAttemptToolRunContext({
      trigger: "manual",
      jobId: "job-1",
      memoryFlushWritePath: "memory/log.md",
      toolsAllow: ["memory_search", "memory_get"],
    });
    expect(context.trigger).toBe("manual");
    expect(context.jobId).toBe("job-1");
    expect(context.memoryFlushWritePath).toBe("memory/log.md");
    expect(context.runtimeToolAllowlist).toEqual(["memory_search", "memory_get"]);
  });

  it.each([undefined, false, true])(
    "preserves originating inbound audio %s",
    (currentInboundAudio) => {
      const context = buildEmbeddedAttemptToolRunContext({ currentInboundAudio });
      const withOperation = buildEmbeddedAttemptToolRunContext({
        currentInboundAudio,
        replyOperation: { acceptedSteeredInboundAudio: false },
      });

      expect(context.hasCurrentInboundAudio?.()).toBe(currentInboundAudio === true);
      expect(withOperation.hasCurrentInboundAudio?.()).toBe(currentInboundAudio === true);
    },
  );

  it("reads accepted steering at execution without crossing operation owners", () => {
    let acceptedSteeredInboundAudio = false;
    const attempt = {
      currentInboundAudio: false,
      replyOperation: {
        get acceptedSteeredInboundAudio() {
          return acceptedSteeredInboundAudio;
        },
      },
    };
    const context = buildEmbeddedAttemptToolRunContext(attempt);
    expect(context.hasCurrentInboundAudio?.()).toBe(false);

    attempt.replyOperation = { acceptedSteeredInboundAudio: true };
    expect(context.hasCurrentInboundAudio?.()).toBe(false);

    acceptedSteeredInboundAudio = true;
    expect(context.hasCurrentInboundAudio?.()).toBe(true);
    expect(
      buildEmbeddedAttemptToolRunContext({
        currentInboundAudio: false,
        replyOperation: { acceptedSteeredInboundAudio: false },
      }).hasCurrentInboundAudio?.(),
    ).toBe(false);
  });
});
