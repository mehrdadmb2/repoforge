import test from "node:test";
import assert from "node:assert/strict";
import { deriveTelegramWebhookHeaderSecret, handleTelegramWebhook, streamTelegramStageArchive } from "../src/telegram.js";

class MemoryKV {
  constructor(initial = {}) { this.data = new Map(Object.entries(initial)); }
  async get(key) { return this.data.has(key) ? this.data.get(key) : null; }
  async put(key, value) { this.data.set(key, value); }
  async delete(key) { this.data.delete(key); }
  async list({ prefix = "", limit = 1000 } = {}) {
    return { keys: [...this.data.keys()].filter((key) => key.startsWith(prefix)).slice(0, limit).map((name) => ({ name })) };
  }
}

const envBase = () => ({
  TELEGRAM_BOT_TOKEN: "test-bot-token",
  TELEGRAM_ADMIN_ID: "123456789",
  TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret-at-least-24-chars",
  DASHBOARD_URL: "https://mehrdadmb2.github.io/repoforge/",
  MAX_ARCHIVE_BYTES: String(19 * 1024 * 1024),
  STAGE_TTL_SECONDS: "3600",
  STATE: new MemoryKV()
});

function request(update, secret = "test-webhook-secret-at-least-24-chars") {
  return new Request("https://worker.example/telegram", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify(update)
  });
}

test("Telegram webhook rejects requests without the configured secret", async () => {
  const env = envBase();
  const response = await handleTelegramWebhook(request({ update_id: 1 }, "wrong-secret"), env);
  assert.equal(response.status, 403);
  assert.equal(env.STATE.data.size, 0);
});

test("Telegram webhook acknowledges quickly and stores ZIP file_id only for the configured admin", async () => {
  const env = envBase();
  await env.STATE.put("tg-selection:123456789", JSON.stringify({ repo: "mehrdadmb2/repoforge", branch: "main" }));
  const previousFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("/sendMessage")) {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, description: "Unexpected Telegram request" }), { status: 500 });
  };
  try {
    const update = {
      update_id: 101,
      message: {
        message_id: 5,
        chat: { id: 123456789, type: "private" },
        from: { id: 123456789 },
        document: { file_id: "telegram-file-reference", file_name: "release.zip", file_size: 1024 }
      }
    };
    const tasks = [];
    const ctx = { waitUntil(promise) { tasks.push(promise); } };
    const response = await handleTelegramWebhook(request(update), env, ctx);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
    assert.equal(tasks.length, 1);
    await Promise.all(tasks);

    const stageKeys = [...env.STATE.data.keys()].filter((key) => /^stage:[a-z0-9]{10}$/.test(key));
    assert.equal(stageKeys.length, 1);
    const stage = JSON.parse(await env.STATE.get(stageKeys[0]));
    assert.equal(stage.telegramFileId, "telegram-file-reference");
    assert.equal(stage.adminId, "123456789");
    assert.equal(stage.repo, "mehrdadmb2/repoforge");
    assert.equal(env.STATE.data.has(`${stageKeys[0]}:archive`), false, "ZIP bytes must not be copied into KV");
    assert.match(sent[0].text, /Open the private dashboard/);
    assert.match(sent[0].reply_markup.inline_keyboard[0][0].url, /\?stage=/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Telegram archive is streamed from Telegram and limited to the administrator's stage", async () => {
  const env = envBase();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/getFile")) {
      assert.equal(JSON.parse(init.body).file_id, "allowed-file-id");
      return new Response(JSON.stringify({ ok: true, result: { file_path: "documents/release.zip", file_size: 4 } }));
    }
    if (url.endsWith("/documents/release.zip")) return new Response(new Uint8Array([1, 2, 3, 4]));
    return new Response("unexpected", { status: 500 });
  };
  try {
    await assert.rejects(
      () => streamTelegramStageArchive(env, { telegramFileId: "other-file", adminId: "999" }),
      /does not belong to the configured administrator/
    );
    const result = await streamTelegramStageArchive(env, { telegramFileId: "allowed-file-id", adminId: "123456789", size: 4 });
    assert.equal(result.size, 4);
    assert.deepEqual([...new Uint8Array(await new Response(result.body).arrayBuffer())], [1, 2, 3, 4]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});


test("Telegram accepts a one-character raw webhook secret through its derived header", async () => {
  const env = envBase();
  env.TELEGRAM_WEBHOOK_SECRET = "x";
  const headerSecret = await deriveTelegramWebhookHeaderSecret("x");
  const response = await handleTelegramWebhook(request({ update_id: 404 }, headerSecret), env);
  assert.equal(response.status, 200);
});

test("Telegram webhook rejects an empty configured raw secret", async () => {
  const env = envBase();
  env.TELEGRAM_WEBHOOK_SECRET = "";
  const response = await handleTelegramWebhook(request({ update_id: 405 }), env);
  assert.equal(response.status, 503);
});

test("Telegram webhook remains compatible with a previously registered raw secret", async () => {
  const env = envBase();
  const response = await handleTelegramWebhook(request({ update_id: 406 }, env.TELEGRAM_WEBHOOK_SECRET), env);
  assert.equal(response.status, 200);
});
