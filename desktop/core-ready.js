/** Readiness belongs to the child we spawned, never an unrelated TCP listener. */
function waitForOwnedCore(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const finish = (err) => {
      clearTimeout(timer);
      child.stderr.removeListener("data", onData);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (err) reject(err);
      else resolve();
    };
    const onError = (err) => finish(err);
    const onExit = (code, signal) => finish(new Error(`Music service exited before becoming ready (${signal || code}). Check the app log for details.`));
    const onData = (chunk) => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        // The Go core emits this only after successfully binding its socket.
        if (line.includes('msg="spotifier listening"')) { finish(); return; }
      }
    };
    const timer = setTimeout(() => finish(new Error("Music service did not become ready in time.")), timeoutMs);
    child.stderr.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}
module.exports = { waitForOwnedCore };
