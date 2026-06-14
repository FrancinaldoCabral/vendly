import 'dotenv/config';

const redisUrl =
  process.env.REDIS_URL ??
  (process.env.REDIS_HOST
    ? `redis://:${process.env.REDIS_PASSWORD ?? ''}@${process.env.REDIS_HOST}:${process.env.REDIS_PORT ?? '6379'}`
    : 'redis://localhost:6379');

export const config = {
  n8n: {
    url: process.env.N8N_URL ?? 'http://localhost:5678',
    apiKey: process.env.N8N_API_KEY ?? '',
  },
  evolution: {
    url: process.env.EVOLUTION_URL ?? 'http://localhost:8080',
    apiKey: process.env.EVOLUTION_API_KEY ?? '',
  },
  chatwoot: {
    url: process.env.CHATWOOT_URL ?? 'http://localhost:3000',
    platformKey: process.env.CHATWOOT_PLATFORM_KEY ?? '',
    // apiKey and accountId are per-tenant (stored in TenantDoc.chatwoot)
    apiKey: '',
    accountId: '',
  },
  mongodb: {
    uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27017',
  },
  redis: {
    url: redisUrl,
  },
  qdrant: {
    url: process.env.QDRANT_URL ?? 'http://localhost:6333',
    apiKey: process.env.QDRANT_API_KEY ?? '',
  },
  coolify: {
    url: process.env.COOLIFY_URL ?? 'http://localhost:8000',
    token: process.env.COOLIFY_TOKEN ?? '',
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY ?? '',
    embeddingModel: process.env.OPENROUTER_EMBEDDING_MODEL ?? 'openai/text-embedding-3-small',
    // Primary chat/reasoning model. Also multimodal (text, audio, image, files, video).
    chatModel: process.env.OPENROUTER_CHAT_MODEL ?? 'google/gemini-3.1-flash-lite',
    // Multimodal model used for transcription / reading media. Same family by default.
    multimodalModel: process.env.OPENROUTER_MULTIMODAL_MODEL ?? 'google/gemini-3.1-flash-lite',
    fallbackModel: process.env.OPENROUTER_FALLBACK_MODEL ?? 'google/gemini-3.1-flash-lite',
    ttlModel: process.env.MODEL_TTS ?? 'google/gemini-3.1-flash-tts-preview',
    ttsVoice: process.env.VOICE_TTS ?? 'Kore',
  },
  admin: {
    apiKey: process.env.ADMIN_API_KEY ?? 'vendly-admin-dev',
  },
  jwt: {
    secret: process.env.JWT_SECRET ?? 'change-me-in-production',
    expiresIn: '30d',
  },
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: parseInt(process.env.SMTP_PORT ?? '587', 10),
    user: process.env.SMTP_USER ?? '',
    password: process.env.SMTP_PASSWORD ?? '',
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? 'noreply@app.chat',
  },
  app: {
    url: process.env.APP_URL ?? 'http://localhost:3001',
    port: parseInt(process.env.PORT ?? '3001', 10),
  },
  woocommerce: {
    webhookSecret: process.env.WOOCOMMERCE_WEBHOOK_SECRET ?? '',
    url: process.env.WC_URL ?? '',
    consumerKey: process.env.WC_CONSUMER_KEY ?? '',
    consumerSecret: process.env.WC_CONSUMER_SECRET ?? '',
    subscriptionProductId: parseInt(process.env.WC_SUBSCRIPTION_PRODUCT_ID ?? '36779', 10),
  },
  wordpress: {
    // Same site as WooCommerce — JWT Auth plugin endpoint
    url: process.env.WP_URL ?? process.env.WC_URL ?? '',
  },
};
