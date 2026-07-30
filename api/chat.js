// Sentra AI — backend proxy (Vercel serverless function)
//
// This function keeps your Gemini API key secret on the server. The website
// (index.html) calls this endpoint at "/api/chat" instead of ever calling
// Google or Anthropic directly from the browser — that's what makes it safe
// to host this site publicly (GitHub Pages for the frontend + Vercel for
// this function, or all on Vercel).
//
// Setup:
//   1. Get a free Gemini API key (no credit card): https://aistudio.google.com/apikey
//   2. In your Vercel project → Settings → Environment Variables, add:
//        GEMINI_API_KEY = <your key>
//   3. (Optional but recommended) Also add ALLOWED_ORIGIN = https://your-site.vercel.app
//      to stop other websites from calling your backend directly. See _security.js.
//   3. Deploy. The site will call this function automatically.

const { rateLimit, checkOrigin } = require('./_security');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }
  if (!checkOrigin(req, res)) return;
  if (!rateLimit(req, res, { windowMs: 60000, max: 20 })) return;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'Server is missing GEMINI_API_KEY. Add it in your Vercel project → Settings → Environment Variables, then redeploy.'
    });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const { system, messages } = body || {};

  if (!Array.isArray(messages) || !messages.length) {
    res.status(400).json({ error: 'No messages provided.' });
    return;
  }
  // Basic payload guards so a malicious caller can't send a huge body and
  // rack up token costs or overwhelm the function.
  if (messages.length > 60) {
    res.status(400).json({ error: 'Too many messages in this conversation.' });
    return;
  }
  const tooLong = messages.some(m => typeof m.content === 'string' && m.content.length > 12000);
  if (tooLong) {
    res.status(400).json({ error: 'One of the messages is too long.' });
    return;
  }

  // Gemini uses "user" / "model" roles instead of "user" / "assistant".
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '') }]
  }));

  const geminiBody = {
    contents,
    generationConfig: { maxOutputTokens: 4096 }
  };
  if (system) {
    geminiBody.system_instruction = { parts: [{ text: String(system) }] };
  }

  // "gemini-flash-latest" is an alias Google keeps pointed at their current
  // free-tier Flash model, so this won't break every time a dated model
  // (like gemini-2.5-flash) gets retired. A couple of dated fallbacks are
  // kept behind it just in case the alias itself is ever unavailable.
  const MODEL_CANDIDATES = ['gemini-flash-latest', 'gemini-3.6-flash', 'gemini-2.5-flash'];

  let lastError = null;
  for (const model of MODEL_CANDIDATES){
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

      const geminiRes = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify(geminiBody)
      });

      const data = await geminiRes.json();

      if (!geminiRes.ok) {
        lastError = (data && data.error && data.error.message) || `Gemini request failed (status ${geminiRes.status}).`;
        // Model not found/retired — try the next candidate instead of failing outright.
        if (geminiRes.status === 404) continue;
        res.status(geminiRes.status).json({ error: lastError });
        return;
      }

      const candidate = data.candidates && data.candidates[0];
      const parts = candidate && candidate.content && candidate.content.parts;
      const reply = Array.isArray(parts) ? parts.map(p => p.text || '').join('\n\n').trim() : '';

      if (!reply) {
        res.status(502).json({ error: 'Gemini returned an empty response (it may have blocked the content — try rephrasing).' });
        return;
      }

      res.status(200).json({ reply, modelUsed: model });
      return;
    } catch (err) {
      lastError = err && err.message ? err.message : 'unknown error';
    }
  }

  res.status(500).json({ error: 'All Gemini models failed. Last error: ' + lastError });
};
