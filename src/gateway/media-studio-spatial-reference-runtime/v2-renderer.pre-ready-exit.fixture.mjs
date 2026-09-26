// A real child process that intentionally exits before the Guardian READY IPC.
setTimeout(() => process.exit(23), 250);
