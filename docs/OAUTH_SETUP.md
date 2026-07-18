# Connecting a subscription (OAuth setup)

RegCompass Open can run AEGIS on a **model subscription** (Claude, ChatGPT, or
Gemini) instead of an API key. Because the app runs locally on your machine, the
sign-in happens over a loopback redirect (the app's own `localhost` callback) and
the token is stored only in `~/.regcompass-open/auth.json` (directory `0700`,
file `0600`, tokens additionally encrypted at rest). Nothing is sent to a shared
server.

Each provider requires a **registered OAuth client**. This is a one-time step you
do with the provider; the app never ships another product's client id. Until a
provider's client id is set, its card on **Konto → AI-Provider → Abo verbinden**
shows *Setup erforderlich*.

The callback URL to register with every provider (default local port):

```
http://localhost:3000/api/aegis/oauth/<provider>/callback
```

where `<provider>` is `anthropic`, `openai`, or `google`. If you run on another
host/port, set `APP_BASE_URL` and register that origin instead.

## Claude (Anthropic)

1. Register an OAuth client with Anthropic and obtain a **client id** and the
   **token endpoint** (Anthropic issues both).
2. Set:

```
ANTHROPIC_OAUTH_CLIENT_ID=...
ANTHROPIC_OAUTH_TOKEN_URL=...        # issued with the client
ANTHROPIC_OAUTH_AUTHORIZE_URL=...    # issued with the client
# optional:
ANTHROPIC_OAUTH_SCOPES=...
ANTHROPIC_OAUTH_CLIENT_SECRET=...    # only if your client is confidential
```

Anthropic has **no public default endpoints** here on purpose — both URLs come
from the client registration, so the provider stays *Setup erforderlich* until
you set them.

## ChatGPT (OpenAI)

1. Register an OAuth client with OpenAI; obtain a **client id**.
2. Set:

```
OPENAI_OAUTH_CLIENT_ID=...
# optional overrides (public defaults are used otherwise):
OPENAI_OAUTH_AUTHORIZE_URL=https://auth.openai.com/oauth/authorize
OPENAI_OAUTH_TOKEN_URL=https://auth.openai.com/oauth/token
OPENAI_OAUTH_SCOPES=openid profile email offline_access
OPENAI_OAUTH_CLIENT_SECRET=...
```

## Gemini (Google)

1. In the Google Cloud console create an **OAuth 2.0 Client ID** (application
   type: Web application) and add the callback URL above as an authorized
   redirect URI. Obtain the **client id** and **client secret**.
2. Set:

```
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
# optional overrides (public defaults are used otherwise):
GOOGLE_OAUTH_AUTHORIZE_URL=https://accounts.google.com/o/oauth2/v2/auth
GOOGLE_OAUTH_TOKEN_URL=https://oauth2.googleapis.com/token
GOOGLE_OAUTH_SCOPES=https://www.googleapis.com/auth/generative-language.retriever
```

## How the token is used

When a subscription is connected for the brain you are running, AEGIS uses that
provider's access token (auto-refreshed before expiry) as a `Bearer` credential.
Credential precedence is: **connected subscription → your API key (BYOK/env) →
the app's own key**. Disconnecting removes the token from the local store.

> Provider API contracts for subscription-billed requests can change and may be
> subject to each provider's developer terms. The connection flow here is
> standards-based (OAuth 2.0 Authorization Code + PKCE, RFC 8252 / RFC 7636);
> confirm your intended usage against the provider's current terms when you
> register the client.
