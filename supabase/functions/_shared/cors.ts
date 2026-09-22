// Shared CORS headers for browser-invoked Edge Functions.
// The desktop app is served from the custom `kcapp://app` origin; '*' keeps it
// simple. Tighten to the exact origin(s) before production if desired.
export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
