import { enqueueSystemEvent } from "../infra/system-events.js";

type ModelRef = {
  provider?: string;
  model?: string;
};

function trim(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const out = value.trim();
  return out.length > 0 ? out : undefined;
}

function modelLabel(ref: ModelRef | undefined): string | undefined {
  const provider = trim(ref?.provider);
  const model = trim(ref?.model);
  if (!provider || !model) {
    return undefined;
  }
  return `${provider}/${model}`;
}

export function enqueueModelSwitchSystemEvent(params: {
  sessionKey: string;
  previous?: ModelRef;
  next?: ModelRef;
}): boolean {
  const nextLabel = modelLabel(params.next);
  if (!nextLabel) {
    return false;
  }
  if (modelLabel(params.previous) === nextLabel) {
    return false;
  }
  return enqueueSystemEvent(
    [
      `Model switched to ${nextLabel}.`,
      "Treat this as the current configured runtime model.",
      "Ignore older transcript or tool-result model labels when asked which model is active.",
    ].join(" "),
    {
      sessionKey: params.sessionKey,
      contextKey: `model:${nextLabel}`,
    },
  );
}
