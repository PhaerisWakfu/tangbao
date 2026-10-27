const encoder = new TextEncoder();

export type PushTarget = { endpoint: string; p256dh: string; auth: string };

export type PushKeys = { publicKey: string; privateKey: string; subject: string };

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function b64urlDecode(value: string): Uint8Array {
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

export async function encryptPush(payload: Uint8Array, userPublic: Uint8Array, userAuth: Uint8Array): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const local = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const remote = await crypto.subtle.importKey("raw", userPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const deriveBits = crypto.subtle.deriveBits.bind(crypto.subtle) as (
    algorithm: { name: string; public: CryptoKey },
    key: CryptoKey,
    length: number,
  ) => Promise<ArrayBuffer>;
  const shared = new Uint8Array(await deriveBits({ name: "ECDH", public: remote }, local.privateKey, 256));
  const localPublic = new Uint8Array((await crypto.subtle.exportKey("raw", local.publicKey)) as ArrayBuffer);
  const ikm = await hkdf(userAuth, shared, concat(encoder.encode("WebPush: info\0"), userPublic, localPublic), 32);
  const key = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const padded = new Uint8Array(payload.length + 1);
  padded.set(payload);
  padded[payload.length] = 2;
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, padded));
  return concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([65]), localPublic, cipher);
}

async function vapidJwt(endpoint: string, keys: PushKeys): Promise<string> {
  const publicKey = b64urlDecode(keys.publicKey);
  const privateKey = b64urlDecode(keys.privateKey);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: b64url(privateKey),
    x: b64url(publicKey.slice(1, 33)),
    y: b64url(publicKey.slice(33)),
  };
  const signing = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = b64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64url(
    encoder.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: keys.subject,
      }),
    ),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signing, encoder.encode(`${header}.${payload}`)),
  );
  return `${header}.${payload}.${b64url(signature)}`;
}

export async function sendWebPush(keys: PushKeys, target: PushTarget, payload: string): Promise<number> {
  const body = await encryptPush(encoder.encode(payload), b64urlDecode(target.p256dh), b64urlDecode(target.auth));
  const token = await vapidJwt(target.endpoint, keys);
  const response = await fetch(target.endpoint, {
    method: "POST",
    headers: {
      TTL: "86400",
      Authorization: `vapid t=${token}, k=${keys.publicKey}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
    },
    body,
  });
  return response.status;
}
