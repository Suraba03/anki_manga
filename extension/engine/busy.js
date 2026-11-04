// The offscreen engine's answer to a page request while the models are not ready: the error code the content
// script retries on, and what the page badge shows meanwhile (bytes downloaded, or that this is the first run).
export function busyReply(status) {
  if (status.state === "ready") return null;
  return {
    ok: false,
    error: status.state === "loading" ? "models_loading" : "models_downloading",
    models: { receivedBytes: status.receivedBytes || 0, totalBytes: status.totalBytes || 0, firstRun: !!status.firstRun },
  };
}
