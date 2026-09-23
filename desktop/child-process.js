/** Wait for actual process exit, not ChildProcess.killed (a signal was sent). */
function stopChild(child, timeoutMs = 3000) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      child.removeListener("exit", done);
      resolve();
    };
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, timeoutMs);
    child.once("exit", done);
    child.kill("SIGTERM");
  });
}

module.exports = { stopChild };
