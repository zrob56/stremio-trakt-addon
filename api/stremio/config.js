import { setCors } from './utils.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.status(204).end();
  }
  setCors(res);
  return res.json({
    sharedApp: !!(process.env.TRAKT_CLIENT_ID && process.env.TRAKT_CLIENT_SECRET),
    ...(process.env.TRAKT_CLIENT_ID ? { clientId: process.env.TRAKT_CLIENT_ID } : {}),
  });
}
