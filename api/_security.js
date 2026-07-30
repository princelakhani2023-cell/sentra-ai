// Sentra AI — shared security helpers for the /api functions.
// (Filename starts with "_" so Vercel does NOT expose this as its own route.)
//
// Two lightweight protections, since this backend is a public URL that
// anyone who finds it could otherwise hammer and burn through your free
// Gemini quota:
//
// 1. Rate limiting — caps requests per visitor per minute. It's stored in
//    memory, so it resets if the serverless function cold-starts on a new
//    instance — this is a real limitation of the free/simple approach, not
//    a bulletproof distributed rate limiter. For personal/friends-scale
//    traffic it's a solid deterrent; for serious scale you'd want Vercel KV
//    or Upstash Redis instead (both have free tiers too, if you ever need it).
//
// 2. Origin checking — if you set ALLOWED_ORIGIN in your Vercel Environment
//    Variables to your site's URL (e.g. https://sentra-ai.vercel.app), these
//    functions will reject requests that don't come from your own site. If
//    you don't set it, this check is skipped (open by default).

const buckets = new Map();

function getClientIp(req){
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function rateLimit(req, res, { windowMs = 60000, max = 20 } = {}){
  const ip = getClientIp(req);
  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket || now > bucket.resetAt){
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(ip, bucket);
  }
  bucket.count++;
  // Keep the map from growing forever on a long-lived warm instance.
  if (buckets.size > 5000) buckets.clear();
  if (bucket.count > max){
    res.status(429).json({ error: 'Too many requests from this device — please wait a minute and try again.' });
    return false;
  }
  return true;
}

function checkOrigin(req, res){
  const allowed = process.env.ALLOWED_ORIGIN;
  if (!allowed) return true; // not configured — skip (open by default)
  const origin = req.headers.origin || req.headers.referer || '';
  const allowList = allowed.split(',').map(s => s.trim()).filter(Boolean);
  const ok = allowList.some(a => origin.indexOf(a) === 0);
  if (!ok){
    res.status(403).json({ error: 'Requests from this origin are not allowed.' });
    return false;
  }
  return true;
}

module.exports = { rateLimit, checkOrigin, getClientIp };
