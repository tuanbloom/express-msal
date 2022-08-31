# Express MSAL

Simple client-side session-based Azure AD authentication for Express.js apps.

## What does this do?

This library wraps [@azure/msal-node](https://www.npmjs.com/package/@azure/msal-node) and [azure-ad-verify-token](https://github.com/justinlettau/azure-ad-verify-token#azure-ad-verify-token) to provide a simple way to run interactive authentication on an Express website that calls APIs authenticated via Bearer Header (without writing a web page that performs MSAL auth or using server-side sessions):

- Azure AD server-side invoked PKCE authentication (for GETs)
- Sets up a session\* containing an access token (JWT) (and any other info you augment the session with)
- RequestHandler sets the authorization header `Bearer {access token}` (for POSTs)
- The bearer token validator handler will set `req.user` to the decoded valid token or return `401 Unauthorized`

The PKCE implementation is based on the official @azure/msal-node [auth-code-pkce sample](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/samples/msal-node-samples/auth-code-pkce/src/index.ts).

## Is it secure\*?

We only use cookie-session with this library, along with secure-as-possible cookie configuration. The logic here is that Azure AD tokens are already persisted in browser storage and are freely available in the browser, however it's definitely possible to configure an insecure session cookie that does not restrict access and can allow cookie data to be leaked.

We strongly advise against storing session data (access tokens) server-side.

Cookies are stored in the browser in plain text and (depending on configuration) cookies are not secure-by-default.

We strongly recommend ensuring you configure your [cookie-session options](https://github.com/expressjs/cookie-session#options) carefully, applying the most restrictive policy for your use-case. E.g. setting `path`, `domain`, `sameSite`, `secure`, `httpOnly` etc.

```ts
const cookieSessionOptions = {
  name: '<session-name>',
  maxAge: 1000 * 60 * 60,
  sameSite: 'strict',
  secure: true,
  httpOnly: true,
}
app.use(cookieSession(cookieSessionOptions))
```

## Getting started

### Front-end authentication

By default:

- adds a PKCE front-end authentication handers to `GET *`
- adds an Azure AD reply authentication handler to `GET /auth`
- adds a logout handler to `GET /logout`
- set the request authorisation header to `Bearer {token}` on `POST *`

```ts
// set up cookie-session
const cookieSessionOptions = {
  name: '<session-name>',
  maxAge: 1000 * 60 * 60,
  sameSite: 'strict',
  secure: true,
  httpOnly: true,
}
app.use(cookieSession(cookieSessionOptions))

// set up front-end auth
const serverUrl = 'https://localhost:4000'
const pkceAuthConfig: AuthConfig = {
  app,
  msalConfig: {
    auth: {
      clientId: '<client ID>',
      authority: 'https://login.microsoftonline.com/<tenant ID>',
    },
  },
  scopes: ['Scope1', 'Scope2'],
  serverUrl,
}
addPKCEAuthentication(pkceAuthConfig)
```

### Back-end authentication

Sets `req.user` to the decoded valid token or returns `401 Unauthorized`.

By default:

- Adds a JWT token validation handler to `POST *`
- Will return 401 Unauthorised for invalid / expired tokens
- Will return 401 Unauthorised if there is no `Bearer {token}` supplied (configurable)

```ts
// set up JWT token validation
const bearerOptions = {
  jwksUri: 'https://login.microsoftonline.com/<tenant ID>/discovery/v2.0/keys',
  issuer: 'https://login.microsoftonline.com/<tenant ID>/v2.0',
  audience: '<audience ID>',
}
addBearerTokenValidationHandler({ app, bearerOptions })
```

## Non default configuration

TODO: specify config options, non-default routes, using request handlers

### Logging

Pass a `Logger` implementation into `addPKCEAuthentication` and `addBearerTokenValidationHandler` for optional logging from this package.

#### @azure/msal-node

Use the MSAL system loggerOptions config to control logging from the @azure/msal package

```ts
const config: Partial<Configuration> = {
  system: {
    loggerOptions: {
      loggerCallback(loglevel: LogLevel, message: string, containsPii: boolean) {
        console.log(message)
      },
      piiLoggingEnabled: false,
      logLevel: LogLevel.Verbose,
    },
  },
}
```

To assist supplying a log function to MSAL, this module exports `toNpmLogLevel` which maps MSAL `LogLevel` values to [npm log level labels](https://github.com/winstonjs/winston#logging-levels), making it easy to integrate a winston `Logger` instance:

```ts
const msalLoggerConfig: Partial<Configuration> = {
  system: {
    loggerOptions: {
      loggerCallback: (level, message) => logger.log(toNpmLogLevel(level), message),
    },
  },
}
```
