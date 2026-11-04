// What the panel knows about the active tab (set by panel.js, read by the views).
// deckChecked: {origin, deck} from the last successful look at Anki's deck list (settings.js loadDecks); null before one.
export const state = { origin: null, tabId: null, deckChecked: null };
