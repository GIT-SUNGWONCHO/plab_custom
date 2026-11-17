// 웹푸시 발송 (RFC 8291 내용 암호화 + RFC 8292 VAPID 서명), 라이브러리 없이 WebCrypto로 구현
//
// 큰 그림
//   폰(브라우저)이 구독하면 { endpoint, keys: { p256dh, auth } }를 줌
//     endpoint: 애플/구글 푸시 서버의 "이 기기 배달 주소"
//     p256dh:   기기의 공개키 (P-256)    auth: 기기와 나눈 16바이트 비밀값
//   보낼 때
//     1) 내용 암호화: 일회용 키 쌍을 만들어 기기 공개키와 ECDH로 공유 비밀을 만들고,
//        HKDF로 AES-128-GCM 키·논스를 뽑아 내용을 암호화 → 푸시 서버는 내용을 못 봄
//     2) VAPID 서명: 우리 서버 개인키로 "누가 보냈는지" JWT에 서명 → 푸시 서버는 구독 때 받은 공개키로 확인

export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface VapidKeys {
  /** 공개키 (비압축 65바이트, base64url) — 화면에서 구독할 때 applicationServerKey로 씀 */
  publicKey: string;
  /** 개인키 JWK (JSON 문자열, 워커 시크릿) */
  privateJwk: string;
  /** 연락처: https URL 또는 mailto: */
  subject: string;
}

const enc = new TextEncoder();

export function b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlDecode(s: string): Uint8Array {
  const t = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/**
 * 내용 암호화 (aes128gcm). 반환값이 그대로 HTTP 본문.
 * 본문 = salt(16) | 레코드 크기(4) | 키 길이(1) | 일회용 공개키(65) | 암호문
 */
export async function encryptPayload(sub: PushSubscriptionJSON, plaintext: Uint8Array, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const uaPublic = b64urlDecode(sub.keys.p256dh);
  const authSecret = b64urlDecode(sub.keys.auth);
  // 1) 일회용 키 쌍 + 기기 공개키로 공유 비밀(ECDH)
  const eph = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", eph.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, eph.privateKey, 256));
  // 2) auth 비밀값을 섞어 입력 키 재료(IKM) 만들기
  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  // 3) 콘텐츠 키(16)와 논스(12)
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  // 4) 내용 + 끝 표시(0x02) 를 AES-GCM으로 암호화
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

/** VAPID JWT: {aud: 푸시 서버 출처, exp, sub} 를 ES256으로 서명 */
export async function vapidAuth(endpoint: string, vapid: VapidKeys, now = Date.now()): Promise<string> {
  const aud = new URL(endpoint).origin;
  const head = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64urlEncode(enc.encode(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: vapid.subject })));
  const key = await crypto.subtle.importKey("jwk", JSON.parse(vapid.privateJwk), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64urlEncode(sig)}, k=${vapid.publicKey}`;
}

export type PushResult = "ok" | "gone" | "error";

/** 한 기기로 보내기. 410/404면 구독이 없어진 것("gone") → 저장된 구독을 지워야 함 */
export async function sendWebPush(
  sub: PushSubscriptionJSON,
  data: unknown,
  vapid: VapidKeys,
  fetchFn: (input: string, init?: RequestInit) => Promise<Response> = (i, n) => fetch(i, n),
): Promise<PushResult> {
  const body = await encryptPayload(sub, enc.encode(JSON.stringify(data)));
  const res = await fetchFn(sub.endpoint, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: {
      authorization: await vapidAuth(sub.endpoint, vapid),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(3 * 3600), // 폰이 꺼져 있으면 3시간까지 보관 후 버림
      urgency: "high",
    },
    body,
  });
  if (res.status === 404 || res.status === 410) return "gone";
  if (!res.ok) {
    console.error("webpush failed", res.status, (await res.text().catch(() => "")).slice(0, 300));
    return "error";
  }
  return "ok";
}
