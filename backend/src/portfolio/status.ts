export type GmgnEnvStatus = {
  gmgnApiKeyConfigured: boolean;
};

export function getGmgnEnvStatus(): GmgnEnvStatus {
  const apiKey = process.env.GMGN_API_KEY?.trim();

  // Only ever report whether a key is configured. The exact character length of
  // a secret is a real disclosure (it narrows a brute-force search and
  // fingerprints the issuing provider) and buys no diagnostic value that the
  // boolean does not already give.
  return {
    gmgnApiKeyConfigured: !!apiKey,
  };
}
