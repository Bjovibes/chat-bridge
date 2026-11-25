'use strict';

/**
 * Chat Bridge - AI provider adapter (main process, CommonJS).
 *
 * callAI(config, {system, user}) -> Promise<{ok, text?, error?}>
 *
 * Law (CONTRACT.md section "B - AI contract"):
 * - openai-compatible: POST {baseUrl}/chat/completions, Bearer key
 * - anthropic:         POST {baseUrl||default}/v1/messages, x-api-key + anthropic-version
 * - 60 s AbortController timeout
 * - non-2xx -> error carries HTTP status + body clipped to 300 chars
 * - the API key NEVER appears in any error, log, or return value
 * - this module never logs anything, on purpose
 */

const DEFAULT_MODELS = {
  'openai-compatible': 'gpt-4o-mini',
  'anthropic': 'claude-sonnet-4-5'
};

const REQUEST_TIMEOUT_MS = 60000;
const BODY_CLIP_CHARS = 300;
const REDACTED = '[redacted]';
const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com';

function trimTrailingSlashes(url) {
  return String(url || '').replace(/\/+$/, '');
}

/** Replace every occurrence of the secret, then collapse whitespace so the
 *  error stays on one line. Scrub happens BEFORE clipping so no fragment of
 *  the key can survive at the clip boundary. */
function scrubBody(raw, secret) {
  let out = String(raw == null ? '' : raw);
  if (secret) {
    out = out.split(secret).join(REDACTED);
  }
  return out.replace(/\s+/g, ' ').trim();
}

function clip(text, max) {
  const s = String(text == null ? '' : text);
  return s.length > max ? s.slice(0, max) : s;
}

function extractOpenAIText(data) {
  try {
    const choice = data.choices && data.choices[0];
    if (!choice) return null;
    if (choice.message && typeof choice.message.content === 'string') {
      return choice.message.content;
    }
    if (typeof choice.text === 'string') {
      return choice.text; // legacy completions-style response
    }
    return null;
  } catch (e) {
    return null;
  }
}

function extractAnthropicText(data) {
  try {
    const blocks = data.content;
    if (!Array.isArray(blocks)) return null;
    const parts = [];
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    return parts.length ? parts.join('\n') : null;
  } catch (e) {
    return null;
  }
}

async function callAI(config, prompt) {
  if (!config || typeof config !== 'object') {
    return { ok: false, error: 'AI config is missing' };
  }
  if (
    !prompt ||
    typeof prompt !== 'object' ||
    typeof prompt.system !== 'string' ||
    typeof prompt.user !== 'string' ||
    !prompt.user.trim()
  ) {
    return { ok: false, error: 'AI prompt is missing or malformed' };
  }
  if (config.provider !== 'openai-compatible' && config.provider !== 'anthropic') {
    return { ok: false, error: 'unknown AI provider: ' + String(config.provider) };
  }
  if (!config.apiKey || typeof config.apiKey !== 'string') {
    return { ok: false, error: 'AI API key is missing in settings' };
  }

  const provider = config.provider;
  const model = config.model || DEFAULT_MODELS[provider];
  let url;
  let headers;
  let body;

  if (provider === 'openai-compatible') {
    if (!config.baseUrl || typeof config.baseUrl !== 'string') {
      return { ok: false, error: 'AI base URL is missing in settings' };
    }
    url = trimTrailingSlashes(config.baseUrl) + '/chat/completions';
    headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': 'Bearer ' + config.apiKey
    };
    body = {
      model: model,
      temperature: 0.7,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user }
      ]
    };
  } else {
    const base = config.baseUrl ? trimTrailingSlashes(config.baseUrl) : ANTHROPIC_DEFAULT_BASE;
    url = base + '/v1/messages';
    headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01'
    };
    body = {
      model: model,
      system: prompt.system,
      max_tokens: 1024,
      messages: [
        { role: 'user', content: prompt.user }
      ]
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    return { ok: false, error: 'provider unreachable (timeout or network)' };
  } finally {
    clearTimeout(timer);
  }

  let raw = '';
  try {
    raw = await res.text();
  } catch (err) {
    raw = '';
  }

  if (!(res.status >= 200 && res.status < 300)) {
    const snippet = clip(scrubBody(raw, config.apiKey), BODY_CLIP_CHARS);
    return { ok: false, error: 'provider HTTP ' + res.status + ': ' + snippet };
  }

  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch (err) {
    data = null;
  }
  if (!data || typeof data !== 'object') {
    return { ok: false, error: 'provider returned no text' };
  }

  const text = provider === 'openai-compatible' ? extractOpenAIText(data) : extractAnthropicText(data);
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, error: 'provider returned no text' };
  }

  return { ok: true, text: text.trim() };
}

module.exports = {
  callAI: callAI,
  DEFAULT_MODELS: DEFAULT_MODELS
};
