/**
 * Google Service Account → access_token minter.
 *
 * The SA's signed JWT (claims include scope + audience=token endpoint) is
 * exchanged for a 1-hour OAuth access_token via the Google token endpoint.
 * We cache the token in module scope per Worker isolate so back-to-back
 * calls don't re-mint. Workers spin up multiple isolates and this cache
 * isn't shared, but each cold-start mints exactly once which is fine.
 *
 * The PEM private key in the JSON file is converted to a CryptoKey via
 * Web Crypto's `importKey` with the PKCS8 format.
 *
 * Env vars (Worker secrets):
 *   GOOGLE_SA_JSON — full Service Account JSON (string)
 */

interface ServiceAccountJson {
  client_email: string;
  private_key: string;
  token_uri: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cached: CachedToken | null = null;

const SCOPE = 'https://www.googleapis.com/auth/calendar';

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const stripped = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');
  const bin = atob(stripped);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return buf;
}

function base64UrlEncode(input: string | ArrayBuffer): string {
  let str: string;
  if (typeof input === 'string') {
    str = btoa(input);
  } else {
    const view = new Uint8Array(input);
    let bin = '';
    for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]!);
    str = btoa(bin);
  }
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function getServiceAccountAccessToken(saJson: string): Promise<string> {
  const now = Date.now();
  if (cached && cached.expiresAt > now + 60_000) {
    return cached.token;
  }

  const sa = JSON.parse(saJson) as ServiceAccountJson;
  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;

  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64UrlEncode(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: sa.token_uri,
      iat,
      exp,
    }),
  );
  const signingInput = `${header}.${claims}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(signingInput),
  );
  const jwt = `${signingInput}.${base64UrlEncode(signature)}`;

  const res = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SA token exchange failed: ${res.status} ${text}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cached = {
    token: json.access_token,
    expiresAt: now + json.expires_in * 1000,
  };
  return json.access_token;
}
