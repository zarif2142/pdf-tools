// The PDF Tools assistant's server: a Cloudflare Worker between the assistant
// page and the Claude API. It keeps the Anthropic API key secret, lets in only
// people with an access code, and streams Claude's answer back as it's written.
//
// POST /check  { }                  -> { name } if the access code is valid
// POST /chat   { messages: [...] }  -> server-sent events: {text} ... {done} or {error}
// Both take the access code as "Authorization: Bearer <code>".

import Anthropic from "@anthropic-ai/sdk";

const MAX_BODY = 24 * 1024 * 1024; // the API takes 32 MB; base64 attachments are large
const MAX_MESSAGES = 80;
const MEDIA = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function systemPrompt(name) {
  return `You are a helpful assistant on a private family website. You are talking with ${name}.

Many of the people using this are not technical, and some are older or more comfortable in another language, so:
- Answer in the language they write in.
- Use plain, warm, everyday words. Explain any term you have to use.
- Keep answers short and get to the point; offer more detail if they want it.
- For step-by-step help (a phone setting, a form, a website), give numbered steps, one action each.

Common requests: explaining letters, bills, forms and documents (they may attach a photo or PDF), writing or replying to emails and messages, filling in forms, and checking whether a message, call or website is a scam. When something shows signs of a scam (urgency, gift cards, wire transfers, requests for passwords or codes, unexpected links), say so clearly and tell them not to reply, click or pay, and to check with family first.

For health, legal, tax or money questions, give clear general information, and say when it is worth asking a doctor, pharmacist, lawyer or accountant. You cannot see their accounts and cannot act for them. If you are unsure, say so rather than guessing.

The same website has free PDF tools that run on their own device: Edit PDF (change the text in a PDF), Fill & sign, Compress, Merge, Split, Organize pages, Images to PDF, PDF to images, Convert images (e.g. iPhone HEIC photos to JPG), add or remove a password, and more. Suggest one when it would help.`;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const cors = allowed.includes(origin) ? {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    } : null;
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { "Content-Type": "application/json", ...cors } });

    if (!cors) return new Response("Not allowed", { status: 403 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ error: "Not found" }, 404);
    const path = new URL(request.url).pathname;
    if (path !== "/check" && path !== "/chat") return json({ error: "Not found" }, 404);

    // slow down anyone guessing codes (per client address, if the limiter is set up)
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (env.LIMITER && !(await env.LIMITER.limit({ key: ip })).success) {
      return json({ error: "Too many requests. Wait a minute and try again." }, 429);
    }

    const name = await checkCode(request.headers.get("Authorization"), env.ACCESS_CODES);
    if (!name) return json({ error: "That access code isn't right." }, 401);
    if (path === "/check") return json({ name });

    const size = Number(request.headers.get("Content-Length") || 0);
    if (size > MAX_BODY) return json({ error: "That's too much to send at once. Try a smaller file." }, 413);
    let messages;
    try {
      messages = cleanMessages((await request.json()).messages);
    } catch (e) {
      return json({ error: e.message || "Bad request" }, 400);
    }
    if (!env.ANTHROPIC_API_KEY) return json({ error: "The assistant isn't set up yet (no API key)." }, 500);

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    const send = (obj) => writer.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
    respond(env, name, messages, send).finally(() => writer.close());
    return new Response(readable, { headers: {
      "Content-Type": "text/event-stream", "Cache-Control": "no-store", ...cors } });
  },
};

async function respond(env, name, messages, send) {
  // ANTHROPIC_BASE_URL is only set for local testing against a stand-in server
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL || undefined });
  const convo = [...messages];
  try {
    // web search runs on Anthropic's side; a long search can pause the turn,
    // which is resumed by sending the conversation back as it is
    for (let round = 0; round < 3; round++) {
      const stream = client.beta.messages.stream({
        model: env.MODEL || "claude-opus-5-5",
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low" },
        system: systemPrompt(name),
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }],
        messages: convo,
      });
      for await (const event of stream) {
        if (event.type === "content_block_start" && event.content_block.type === "server_tool_use") {
          await send({ status: "Searching the web…" });
        } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          await send({ text: event.delta.text });
        }
      }
      const msg = await stream.finalMessage();
      if (msg.stop_reason === "pause_turn") {
        convo.push({ role: "assistant", content: msg.content });
        continue;
      }
      if (msg.stop_reason === "refusal") {
        await send({ error: "Claude can't help with that request." });
        return;
      }
      await send({ done: true, truncated: msg.stop_reason === "max_tokens" });
      return;
    }
    await send({ done: true });
  } catch (err) {
    console.error(err);
    let message = "Something went wrong. Try again in a moment.";
    if (err instanceof Anthropic.RateLimitError) message = "The assistant is busy right now. Try again in a minute.";
    else if (err instanceof Anthropic.AuthenticationError) message = "The assistant's API key isn't working. Ask Zarif to check it.";
    else if (err instanceof Anthropic.BadRequestError) message = "That couldn't be sent (a file may be too large or unreadable).";
    else if (err instanceof Anthropic.APIError && err.status >= 500) message = "Claude is having trouble right now. Try again in a few minutes.";
    await send({ error: message });
  }
}

// "Bearer <code>" -> the person's name, comparing in constant time
async function checkCode(header, codes) {
  const given = /^Bearer (.+)$/.exec(header || "")?.[1]?.trim();
  if (!given || !codes) return null;
  const digest = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const g = await digest(given);
  let found = null;
  for (const pair of codes.split(",")) {
    const i = pair.indexOf(":");
    if (i < 1) continue;
    const name = pair.slice(0, i).trim(), code = pair.slice(i + 1).trim();
    if (code.length >= 8 && crypto.subtle.timingSafeEqual(g, await digest(code))) found ??= name;
  }
  return found;
}

// Only plain text, images and PDFs, in alternating turns starting with the user
function cleanMessages(list) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_MESSAGES) throw new Error("Bad conversation");
  return list.map((m, i) => {
    const role = i % 2 === 0 ? "user" : "assistant";
    if (m?.role !== role) throw new Error("Bad conversation");
    if (typeof m.content === "string") {
      if (!m.content.trim()) throw new Error("Empty message");
      return { role, content: m.content };
    }
    if (!Array.isArray(m.content) || !m.content.length) throw new Error("Bad message");
    const content = m.content.map((b) => {
      if (b?.type === "text" && typeof b.text === "string") return { type: "text", text: b.text };
      if (role === "user" && b?.type === "image" && MEDIA.has(b.source?.media_type) && typeof b.source?.data === "string") {
        return { type: "image", source: { type: "base64", media_type: b.source.media_type, data: b.source.data } };
      }
      if (role === "user" && b?.type === "document" && b.source?.media_type === "application/pdf" && typeof b.source?.data === "string") {
        return { type: "document", source: { type: "base64", media_type: "application/pdf", data: b.source.data } };
      }
      throw new Error("That kind of attachment isn't supported.");
    });
    return { role, content };
  });
}

export { checkCode, cleanMessages };
