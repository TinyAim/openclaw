import { afterEach, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import * as sessionEntryReads from "../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import * as attachments from "../chat-attachments.js";
import { createChatRunState } from "../server-chat-state.js";
import { prepareAgentContentPhase } from "./agent-content-phase.js";
import type { AgentTurnContext } from "./types.js";

let state: OpenClawTestState | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await state?.cleanup();
});

it.each([
  [
    "known image admission",
    new attachments.UnsupportedAttachmentError("text-only-image", "private attachment path"),
    true,
  ],
  [
    "different unsupported attachment",
    new attachments.UnsupportedAttachmentError("empty-payload", "private attachment path"),
    false,
  ],
  [
    "message-only lookalike",
    Object.assign(new Error("active model does not accept image inputs"), {
      name: "UnsupportedAttachmentError",
      reason: "text-only-image",
    }),
    false,
  ],
] as const)("emits no-submit details only for %s", async (_name, error, expected) => {
  vi.spyOn(attachments, "parseMessageWithAttachments").mockRejectedValueOnce(error);
  const respond = vi.fn();
  const result = await prepareAgentContentPhase({
    request: { message: "read image", idempotencyKey: "original-run" },
    cfg: {},
    isRawModelRun: true,
    respond,
    knownAgents: [],
    normalizedAttachments: [
      { type: "image", mimeType: "image/png", fileName: "image.png", content: "aW1hZ2U=" },
    ],
    context: {
      logGateway: { error: vi.fn(), warn: vi.fn() },
      loadGatewayModelCatalog: vi.fn(async () => []),
    } as unknown as AgentTurnContext,
  });
  // Undefined content stops agent-turn-service before native/provider submit.
  expect(result).toBeUndefined();
  expect(respond).toHaveBeenCalledOnce();
  const response = respond.mock.calls[0]!;
  expect(response[0]).toBe(false);
  expect(response[2]).toMatchObject({ code: "INVALID_REQUEST" });
  expect(response[2].details).toEqual(
    expected
      ? {
          reasonCode: "attachment_image_input_unsupported",
          phase: "attachment_admission",
          providerEffects: "none",
          clientRunId: "original-run",
        }
      : undefined,
  );
});

it.each([
  { name: "main", agentId: "main", replaceDuringRead: false },
  { name: "work", agentId: "work", replaceDuringRead: false },
  { name: "replacement work", agentId: "work", replaceDuringRead: true },
])(
  "admits images using the explicit $name global session owner",
  async ({ agentId, replaceDuringRead }) => {
    state = await createOpenClawTestState({ label: "agent-content-owner" });
    const { stateDir, workspaceDir } = state;
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: {
          main: { model: "mock-openai/main-vision" },
          work: { model: "mock-openai/work-vision" },
        },
        defaults: { workspace: state.workspaceDir },
      },
      plugins: { enabled: false },
      session: { scope: "global" },
    };
    await state.writeConfig(cfg);
    if (replaceDuringRead) {
      const scope = { agentId, sessionKey: "global", env: state.env };
      await replaceSessionEntry(scope, {
        sessionId: "previous-text-session",
        lifecycleRevision: "previous-lifecycle",
        updatedAt: 1,
        providerOverride: "mock-openai",
        modelOverride: "text-only",
      });
      const read = sessionEntryReads.withSessionEntryReadOnlyInWorker;
      vi.spyOn(sessionEntryReads, "withSessionEntryReadOnlyInWorker").mockImplementationOnce(
        async (...args) => {
          await replaceSessionEntry(scope, {
            sessionId: "replacement-vision-session",
            lifecycleRevision: "replacement-lifecycle",
            updatedAt: 2,
            providerOverride: "mock-openai",
            modelOverride: `${agentId}-vision`,
          });
          return await read(...args);
        },
      );
    }
    const loadGatewayModelCatalogSnapshot = vi.fn<
      AgentTurnContext["loadGatewayModelCatalogSnapshot"]
    >(async (params) => ({
      agentId: params?.agentId ?? agentId,
      agentDir: stateDir,
      workspaceDir,
      catalogComplete: true,
      config: cfg,
      entries: [
        {
          id: "text-only",
          name: "Synthetic text model",
          provider: "mock-openai",
          input: ["text"],
        } satisfies ModelCatalogEntry,
        {
          id: `${params?.agentId}-vision`,
          name: "Synthetic vision model",
          provider: "mock-openai",
          input: ["text", "image"],
        } satisfies ModelCatalogEntry,
      ],
      routeVariants: [],
    }));
    const context: AgentTurnContext = {
      addChatRun: vi.fn(),
      agentRunSeq: new Map(),
      broadcast: vi.fn(),
      broadcastToConnIds: vi.fn(),
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map(),
      chatRunState: createChatRunState(),
      dedupe: new Map(),
      deps: {},
      getRuntimeConfig: () => cfg,
      trackExecution: async (work) => await work(),
      getSessionEventSubscriberConnIds: () => new Set(),
      loadGatewayModelCatalog: vi.fn(async () => []),
      loadGatewayModelCatalogSnapshot,
      logGateway: createSubsystemLogger("test/agent-content"),
      nodeSendToSession: vi.fn(),
      removeChatRun: vi.fn(() => undefined),
    };
    const respond = vi.fn();
    const result = await prepareAgentContentPhase({
      request: {
        message: "Inspect this synthetic pixel",
        agentId,
        sessionKey: "global",
        idempotencyKey: `image-${agentId}`,
      },
      cfg,
      context,
      respond,
      isRawModelRun: false,
      requestedSessionKeyRaw: "global",
      requestedSessionKey: "global",
      agentId,
      knownAgents: ["main", "work"],
      normalizedAttachments: [
        {
          type: "file",
          mimeType: "image/png",
          fileName: "pixel.png",
          content:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        },
      ],
    });
    expect(respond).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      agentId,
      requestedSessionKey: "global",
      images: [expect.objectContaining({ mimeType: "image/png" })],
    });
    expect(loadGatewayModelCatalogSnapshot).toHaveBeenCalledExactlyOnceWith({
      agentId,
      readOnly: true,
    });
  },
);
