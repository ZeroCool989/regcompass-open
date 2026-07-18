export function checkEnv() {
  const required = ['DATABASE_URL'];
  const optional = ['ANTHROPIC_API_KEY'];

  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const missingOptional = optional.filter(key => !process.env[key]);
  if (missingOptional.length > 0) {
    console.warn(`Missing optional environment variables: ${missingOptional.join(', ')}. AI explanations will use fallback text.`);
  }
}
