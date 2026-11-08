// Alerts to the owner: a generic message channel (Telegram first) and the alert texts.
// No D1 and no request logic here; explain.js decides when an alert fires.

const SEND_TIMEOUT_MS = 10000;

// Generic: the owner's bot may carry other messages later. Errors carry the status only: never the token or the URL.
// A hung call must reject, so the caller releases its claim and the cron retries: hence the timeout
// (a plain timer like callDeepSeek's; AbortSignal.timeout's timer is unref'd and lets a test process exit while waiting).
export async function sendTelegram(text, { token, chatId, fetch: doFetch = fetch, timeoutMs = SEND_TIMEOUT_MS }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await doFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      signal: ctl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (!resp.ok) throw Object.assign(new Error("Telegram HTTP error"), { status: resp.status });
  } finally {
    clearTimeout(timer);
  }
}

// Senders by configured channel. A webhook sender would be one more `if` here.
function sendersFor(env, { fetch: doFetch, timeoutMs }) {
  const senders = [];
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    senders.push((text) => sendTelegram(text, { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID, fetch: doFetch, timeoutMs }));
  }
  return senders;
}

// -> async (text) => void, or null when no channel is configured. A failing sender's error propagates (the caller logs it).
export function makeNotifier(env, { fetch: doFetch, timeoutMs } = {}) {
  const senders = sendersFor(env, { fetch: doFetch, timeoutMs });
  if (senders.length === 0) return null;
  return async (text) => {
    for (const send of senders) await send(text);
  };
}

// 2 decimals, without trailing zeros: 8.01, 10, 2.6
const usd = (n) => String(Number(n.toFixed(2)));

// The first day of the month after "YYYY-MM", as YYYY-MM-DD.
function nextMonthStart(month) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

const PREFIX = "anki-manga free tier:";

// Short plain text. Amounts and dates only: never bubble text, addresses, hashes or install IDs.
export function alertText(kind, { used, cap, month, usd: dayUsd, day, threshold, at } = {}) {
  switch (kind) {
    case "month_80":
      return `${PREFIX} 80% of the monthly budget used (${usd(used)} of ${usd(cap)} USD, ${month}).`;
    case "month_100":
      return `${PREFIX} 100% of the monthly budget used (${usd(used)} of ${usd(cap)} USD, ${month}); the free tier is now off until ${nextMonthStart(month)} (UTC).`;
    case "day_spike":
      return `${PREFIX} unusual daily spend: ${usd(dayUsd)} USD on ${day} (alert threshold ${usd(threshold)} USD).`;
    case "test":
      return `${PREFIX} test alert (sent at ${at.toISOString()}).`;
    default:
      throw new Error(`unknown alert kind ${kind}`);
  }
}
