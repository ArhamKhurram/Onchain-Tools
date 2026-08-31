import { detectAlgorithm } from '../utils/gmgnSigner.js';

function normalizePrivateKeyPem(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

export type GmgnEnvStatus = {
  gmgnApiKeyConfigured: boolean;
  gmgnPrivateKeyConfigured: boolean;
  gmgnPrivateKeyAlgorithm: string | null;
  gmgnPrivateKeyParseError: string | null;
};

export function getGmgnEnvStatus(): GmgnEnvStatus {
  const apiKey = process.env.GMGN_API_KEY?.trim();
  const privateKeyPem = normalizePrivateKeyPem(process.env.GMGN_PRIVATE_KEY);

  let algorithm: string | null = null;
  let parseError: string | null = null;
  if (privateKeyPem) {
    try {
      algorithm = detectAlgorithm(privateKeyPem);
    } catch (err) {
      parseError = (err as Error).message;
    }
  }

  // Only ever report whether a key is configured. The exact character length of
  // a secret is a real disclosure (it narrows a brute-force search and
  // fingerprints the issuing provider) and buys no diagnostic value that the
  // boolean does not already give.
  return {
    gmgnApiKeyConfigured: !!apiKey,
    gmgnPrivateKeyConfigured: !!privateKeyPem && !parseError,
    gmgnPrivateKeyAlgorithm: algorithm,
    gmgnPrivateKeyParseError: parseError,
  };
}
