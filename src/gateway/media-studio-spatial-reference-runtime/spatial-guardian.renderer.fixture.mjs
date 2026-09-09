// Test-only renderer child used to exercise the real private guardian entry.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function waitForStart() {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
    };
    const onMessage = (message) => {
      if (message?.type !== "openclaw-worker-start-v1") return;
      cleanup();
      resolve();
    };
    const onDisconnect = () => {
      cleanup();
      reject(new Error("fixture_parent_lost"));
    };
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
  });
}

async function run() {
  const requestPath = argument("--request");
  const manifestPath = argument("--manifest");
  if (!requestPath || !manifestPath) throw new Error("fixture_arguments_invalid");
  process.send?.({ type: "openclaw-worker-ready-v1" });
  await waitForStart();
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  const outputs = [];
  for (const output of request.outputs) {
    const file = `guardian-${output.slot}-${output.ordinal}.png`;
    await writeFile(path.join(request.workDir, file), Buffer.from("guardian-fixture"), {
      flag: "wx",
    });
    outputs.push({ slot: output.slot, ordinal: output.ordinal, file });
  }
  await writeFile(manifestPath, JSON.stringify({ outputs }), { flag: "wx" });
  process.disconnect?.();
}

void run().catch(() => {
  process.exitCode = 1;
});
