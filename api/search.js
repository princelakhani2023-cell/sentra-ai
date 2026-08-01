// Sentra AI — real-time web search endpoint (Vercel serverless function)
//
// Used only when the user turns on the search toggle for a message. Runs
// one grounded query through Gemini's built-in Google Search tool (free up
// to 5,000 grounded prompts/month on Gemini 3.x models, then billed) and
// returns a short summary plus the source links, so the main chat call can
// use fresh, cited information instead of relying on the model's training
// data alone.

let rateLimit = () => true;
let checkOrigin = () => true;
try {
  ({ rateLimit, checkOrigin } = require('./_security'));
} catch (e) {
  console.error('Sentra: _security.js not found — running without rate limiting/origin checks.');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }
  if (!checkOrigin(req, res)) return;
  // Search grounding costs real money past the free monthly quota, so this
  // one gets a tighter limit than plain chat.
  if (!rateLimit(req, res, { windowMs: 60000, max: 8 })) return;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing GEMINI_API_KEY.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const query = body && body.query;
  if (!query || typeof query !== 'string'){
    res.status(400).json({ error: 'No query provided.' });
    return;
  }
  if (query.length > 500){
    res.status(400).json({ error: 'Search query is too long.' });
    return;
  }

  const geminiBody = {
    contents: [{ role: 'user', parts: [{ text: query }] }],
    tools: [{ google_search: {} }],
    generationConfig: { maxOutputTokens: 1024 }
  };

  // Same fallback chain as chat.js, in case a specific dated model 404s.
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

      if (!geminiRes.ok){
        lastError = (data && data.error && data.error.message) || `Search request failed (${geminiRes.status}).`;
        if (geminiRes.status === 404) continue;
        res.status(geminiRes.status).json({ error: lastError });
        return;
      }

      const candidate = data.candidates && data.candidates[0];
      const parts = candidate && candidate.content && candidate.content.parts;
      const summary = Array.isArray(parts) ? parts.map(p => p.text || '').join('\n\n').trim() : '';

      let sources = [];
      const groundingChunks = candidate && candidate.groundingMetadata && candidate.groundingMetadata.groundingChunks;
      if (Array.isArray(groundingChunks)){
        sources = groundingChunks
          .map(c => c.web && { title: c.web.title || c.web.uri, uri: c.web.uri })
          .filter(Boolean)
          .slice(0, 5);
      }

      res.status(200).json({ summary: summary || null, sources });
      return;
    } catch (err) {
      lastError = err && err.message ? err.message : 'unknown error';
    }
  }

  res.status(500).json({ error: 'All models failed for search. Last error: ' + lastError });
};
