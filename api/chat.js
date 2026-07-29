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
//   3. Deploy. The site will call this function automatically.

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

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

  try {
    // gemini-2.5-flash is on Google's free tier (no billing required).
    const model = 'gemini-2.5-flash';
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
      const msg = (data && data.error && data.error.message) || `Gemini request failed (status ${geminiRes.status}).`;
      res.status(geminiRes.status).json({ error: msg });
      return;
    }

    const candidate = data.candidates && data.candidates[0];
    const parts = candidate && candidate.content && candidate.content.parts;
    const reply = Array.isArray(parts) ? parts.map(p => p.text || '').join('\n\n').trim() : '';

    if (!reply) {
      res.status(502).json({ error: 'Gemini returned an empty response (it may have blocked the content — try rephrasing).' });
      return;
    }

    res.status(200).json({ reply });
  } catch (err) {
    res.status(500).json({ error: 'Server error contacting Gemini: ' + (err && err.message ? err.message : 'unknown error') });
  }
};
