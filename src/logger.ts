type Level = "info" | "warn" | "error" | "debug";

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), level, msg, ...meta };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else console.log(line);
}

export const log = {
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
};
