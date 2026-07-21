import { createPrivateKey, randomUUID, sign as cryptoSign, constants } from 'crypto';

export type SignAlgorithm = 'Ed25519' | 'RSA-SHA256';

export function detectAlgorithm(pem: string): SignAlgorithm {
  const key = createPrivateKey(pem);
  switch (key.asymmetricKeyType) {
    case 'ed25519':
      return 'Ed25519';
    case 'rsa':
      return 'RSA-SHA256';
    default:
      throw new Error(`Unsupported GMGN private key type: ${key.asymmetricKeyType}`);
  }
}

export function buildAuthQuery(): { timestamp: number; client_id: string } {
  return {
    timestamp: Math.floor(Date.now() / 1000),
    client_id: randomUUID(),
  };
}

export function buildSignatureMessage(
  subPath: string,
  queryParams: Record<string, string | number | string[]>,
  body: string,
  timestamp: number,
): string {
  const sortedQs = Object.keys(queryParams)
    .sort()
    .flatMap((k) => {
      const ek = encodeURIComponent(k);
      const v = queryParams[k];
      if (Array.isArray(v)) {
        return [...v].sort().map((item) => `${ek}=${encodeURIComponent(item)}`);
      }
      return [`${ek}=${encodeURIComponent(String(v))}`];
    })
    .join('&');
  return `${subPath}:${sortedQs}:${body}:${timestamp}`;
}

export function signMessage(message: string, privateKeyPem: string, algorithm: SignAlgorithm): string {
  const msgBuf = Buffer.from(message, 'utf-8');
  if (algorithm === 'Ed25519') {
    return cryptoSign(null, msgBuf, privateKeyPem).toString('base64');
  }
  return cryptoSign('sha256', msgBuf, {
    key: privateKeyPem,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  }).toString('base64');
}
