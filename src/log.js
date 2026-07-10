const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function pad(level) {
  return level.toUpperCase().padEnd(5, " ");
}

export function createLogger(level = "info", { now = () => new Date() } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(msgLevel, component, message) {
    if (LEVELS[msgLevel] < threshold) return;
    const line = `${now().toISOString()} ${pad(msgLevel)} ${component}  ${message}`;
    if (msgLevel === "error") {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  return {
    debug: (component, message) => write("debug", component, message),
    info: (component, message) => write("info", component, message),
    warn: (component, message) => write("warn", component, message),
    error: (component, message) => write("error", component, message),
  };
}
