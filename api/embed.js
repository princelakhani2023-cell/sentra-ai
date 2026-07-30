// Sentra AI — embeddings endpoint (Vercel serverless function)
//
// Turns a piece of text into a vector (list of numbers) using Gemini's free
// embedding model. The frontend stores these vectors locally (in the
// browser's storage) next to the text they came from — that's Sentra's
// "long-term memory": no separate vector database service to sign up for,
// just numbers stored alongside your chats, compared with plain cosine
// similarity in the browser when a new message comes in.

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing GEMINI_API_KEY.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const text = body && body.text;
  if (!text || typeof text !== 'string'){
    res.status(400).json({ error: 'No text provided.' });
    return;
  }

  try {
    const model = 'gemini-embedding-001';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`;
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        content: { parts: [{ text: text.slice(0, 8000) }] },
        outputDimensionality: 768
      })
    });

    const data = await geminiRes.json();
    if (!geminiRes.ok){
      const msg = (data && data.error && data.error.message) || `Embedding request failed (${geminiRes.status}).`;
      res.status(geminiRes.status).json({ error: msg });
      return;
    }

    const values = data.embedding && data.embedding.values;
    if (!Array.isArray(values)){
      res.status(502).json({ error: 'Embedding response was empty.' });
      return;
    }

    // Rounding trims JSON size noticeably with no meaningful loss for
    // cosine-similarity search, which matters since these get stored in
    // the browser (localStorage/artifact storage), not a real database.
    const vector = values.map(v => Math.round(v * 100000) / 100000);
    res.status(200).json({ vector });
  } catch (err) {
    res.status(500).json({ error: 'Server error contacting Gemini: ' + (err && err.message ? err.message : 'unknown error') });
  }
};
