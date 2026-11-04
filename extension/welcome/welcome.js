// Welcome tab, opened once on install: mirrors the engine's start-up line (the same text as the side panel) while
// the models download. It only reads chrome.storage.session; starting the engine is the service worker's job.
import { modelStatusLine } from "../panel/logic.js";

const $ = (id) => document.getElementById(id);

function show(s) {
  const line = modelStatusLine(s);
  $("status").dataset.state = line.kind;
  $("status").textContent = line.text;
  const note = line.kind === "ready" ? "All set. Open a manga page to start." : line.kind === "down" ? "Open the side panel to try again." : "";
  $("status-note").hidden = !note;
  $("status-note").textContent = note;
  $("next-title").textContent = line.kind === "ready" ? "Next" : "While you wait";
  $("background-note").hidden = line.kind !== "warming";
}

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.modelStatus) show(changes.modelStatus.newValue);
});
chrome.storage.session.get("modelStatus").then(({ modelStatus }) => show(modelStatus));
