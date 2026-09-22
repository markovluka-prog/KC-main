/**
 * Phase 3 T3.1 — zod-validated environment configuration. Crashes
 * fast at boot if any required secret/URL is missing. The server reads
 * EVERY runtime knob through this object so misconfiguration is loud.
 *
 * Local dev: `.env.local` (loaded by Vite-style tooling or `direnv`).
 * Cloud Run: Secret Manager mounts via `--set-secrets` (see
 * infra/scripts/deploy-dev.sh).
 */
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8080),

  /** Postgres connection string (Cloud SQL Unix socket on Cloud Run). */
  DATABASE_URL: z.string().min(1),

  /**
   * Ed25519 private key in JWK JSON form for signing access tokens.
   * Public key is derived. NR-2: rotate carefully — old tokens invalidate.
   */
  JWT_PRIVATE_KEY_JWK: z.string().min(1),

  /** Google OIDC client. Apple separately (DP-3.2). */
  GOOGLE_OIDC_CLIENT_ID: z.string().optional(),
  GOOGLE_OIDC_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OIDC_REDIRECT_URI: z.string().url().optional(),

  /** Postmark API token for transactional email (verification, reset). */
  POSTMARK_API_TOKEN: z.string().optional(),
  POSTMARK_FROM_EMAIL: z.string().email().default('no-reply@knights-castles.local'),

  /** CORS allowlist — comma-separated origins. */
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  /** Log level. */
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /** Ollama base URL. Set to use a local Ollama instance (no API key needed). */
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),

  /** Ollama model name, e.g. "llama3.2", "mistral", "qwen2.5:3b". */
  OLLAMA_MODEL: z.string().default('llama3.2'),

  /** OpenRouter API key — fallback if Ollama is unavailable. */
  OPENROUTER_API_KEY: z.string().optional(),

  /** OpenRouter model name. */
  OPENROUTER_MODEL: z.string().default('meta-llama/llama-3.1-8b-instruct:free'),

  /** OpenRouter base URL. Override to point tests at a local stub. */
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),

  /**
   * Groq API key (https://console.groq.com) — free hosted model, and the first
   * hosted provider tried after Ollama. OpenAI-compatible, so it goes through
   * the normal client; measured ~250 ms per turn with 1000 requests/day and no
   * gap enforced between consecutive requests, which is what makes it usable
   * inside a game turn at all.
   */
  GROQ_API_KEY: z.string().optional(),

  /** Groq base URL. Override to point tests at a local stub. */
  GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),

  /** Groq model name. Must support `response_format: json_object`. */
  GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),

  /**
   * ApiFreeLLM API key (https://apifreellm.com) — free hosted model, tried
   * after Groq. Its free tier is NOT OpenAI-compatible (that endpoint is
   * Premium-only), so ai-move.ts calls it directly. Its rate limit forces a
   * 10-20 s gap between requests, so prefer Groq when both are configured.
   */
  APIFREELLM_API_KEY: z.string().optional(),

  /** ApiFreeLLM base URL. Override to point tests at a local stub. */
  APIFREELLM_BASE_URL: z.string().url().default('https://apifreellm.com'),

  /**
   * How long to wait out ApiFreeLLM's free-tier rate limit (429 + retryAfter)
   * before abandoning it for the next provider. A game turn must not hang, and
   * the local MCTS fallback is a good answer, so keep this small.
   */
  APIFREELLM_MAX_WAIT_MS: z.coerce.number().int().nonnegative().default(8000),

  /**
   * Auth gate mode. 'production' enforces JWT; 'dev-bypass' injects a fake
   * user-id from DEV_BYPASS_USER_ID so backend endpoints work locally
   * without going through the Google OIDC redirect. NEVER set to
   * dev-bypass on prod — it disables all auth.
   */
  AUTH_MODE: z.enum(['production', 'dev-bypass']).default('production'),
  DEV_BYPASS_USER_ID: z.string().uuid().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Environment validation failed:\n${issues}`);
  }
  // Cross-field invariants.
  if (parsed.data.NODE_ENV === 'production' && parsed.data.AUTH_MODE === 'dev-bypass') {
    throw new Error('AUTH_MODE=dev-bypass is forbidden in production. Refuse to start.');
  }
  if (parsed.data.AUTH_MODE === 'dev-bypass' && !parsed.data.DEV_BYPASS_USER_ID) {
    throw new Error('AUTH_MODE=dev-bypass requires DEV_BYPASS_USER_ID to be set.');
  }
  cached = parsed.data;
  return cached;
}

export function getCorsOrigins(env: Env): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
