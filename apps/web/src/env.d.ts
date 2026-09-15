// Addresses and keys the build reads from PUBLIC_ variables; each one is optional
interface ImportMetaEnv {
  readonly PUBLIC_API_URL?: string;
  readonly PUBLIC_ASK_URL?: string;
  readonly PUBLIC_TURNSTILE_SITE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
