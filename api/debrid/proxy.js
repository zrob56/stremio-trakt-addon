const RD_BASE = 'https://api.real-debrid.com/rest/1.0';

export default async function handler(req, res) {
  // Handle CORS preflight (vercel.json supplies the CORS headers)
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Check for auth token
  const token = req.headers['x-rd-token'];
  if (!token) {
    res.status(401).json({ error: 'Missing X-RD-Token header' });
    return;
  }

  // Extract the Real-Debrid API path from the request URL
  // Request comes in as /api/debrid/proxy?path=/unrestrict/link or via rewrite
  const url = new URL(req.url, `http://${req.headers.host}`);
  let rdPath = url.pathname.replace(/^\/api\/debrid\/proxy\/?/, '').replace(/^\/api\/debrid\/?/, '');

  // If path is empty, check query parameter
  if (!rdPath) {
    rdPath = url.searchParams.get('path') || '';
    url.searchParams.delete('path');
  }

  if (!rdPath) {
    res.status(400).json({ error: 'No API path specified' });
    return;
  }

  // Build target URL with any remaining query parameters
  const queryString = url.searchParams.toString();
  const targetUrl = `${RD_BASE}/${rdPath}${queryString ? '?' + queryString : ''}`;

  // Build fetch options
  const fetchOptions = {
    method: req.method,
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  };

  // Forward body for POST/PUT requests
  if (req.method === 'POST' || req.method === 'PUT') {
    const contentType = req.headers['content-type'] || 'application/x-www-form-urlencoded';
    fetchOptions.headers['Content-Type'] = contentType;

    // Read the request body
    if (typeof req.body === 'string') {
      fetchOptions.body = req.body;
    } else if (req.body && typeof req.body === 'object') {
      // Vercel parses JSON/urlencoded bodies automatically
      // Re-encode as form data for Real-Debrid
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(req.body)) {
        params.append(key, value);
      }
      fetchOptions.body = params.toString();
      fetchOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  }

  try {
    const rdResponse = await fetch(targetUrl, fetchOptions);
    const contentType = rdResponse.headers.get('content-type') || 'application/json';
    const data = await rdResponse.text();

    res.setHeader('Content-Type', contentType);
    res.status(rdResponse.status).send(data);
  } catch (error) {
    res.status(502).json({ error: 'Failed to reach Real-Debrid API', details: error.message });
  }
}
