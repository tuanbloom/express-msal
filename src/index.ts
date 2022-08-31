import {
  AuthenticationResult,
  AuthorizationCodeRequest,
  AuthorizationUrlRequest,
  Configuration,
  CryptoProvider,
  LogLevel,
  PublicClientApplication,
} from '@azure/msal-node'
import { Logger } from '@makerxstudio/node-common'
import { Express, Request, RequestHandler } from 'express'

// implementation based on the official pkce sample:
// https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/samples/msal-node-samples/auth-code-pkce/src/index.ts

interface PKCECodes {
  challengeMethod: string
  challenge?: string
  verifier?: string
}

export type Session = Record<string, unknown>
type MaybeSession = Record<string, unknown> | null | undefined
type PKCEStartedSession = Session & { originalUrl: string; pkceCodes: PKCECodes }
export type AuthenticatedSession = Session & {
  isAuthenticated: true
  accessToken: string
}

const isCookieSession = (session: Session) => {
  return 'isChanged' in session && 'isNew' in session && 'isPopulated' in session
}
const isPKCEStartedSession = (session: MaybeSession): session is PKCEStartedSession => {
  return Boolean(session?.pkceCodes)
}
export const isAuthenticatedSession = (session: MaybeSession): session is AuthenticatedSession => {
  return session?.isAuthenticated === true
}

type AuthInput = Pick<AuthConfig, 'scopes'> & {
  pca: PublicClientApplication
  authReplyRoute: string
}

const createEnsureAuthenticatedHandler = ({ pca, scopes, authReplyRoute }: AuthInput): RequestHandler => {
  const login = createLoginHandler({ pca, scopes, authReplyRoute })
  return (req, res, next) => {
    if (!req.session) throw Error('Express session is not available')
    if (!isCookieSession(req.session)) throw Error('Only cookie-session sessions are supported')
    if (isAuthenticatedSession(req.session)) return next()
    login(req, res, next)
  }
}

const PROXY_PATH = process.env.PROXY_PATH ?? ''
const createReplyUrl = (req: Request, replyRoute: string) => {
  const hostAndPort = req.get('Host') ?? ''
  return `${req.protocol}://${hostAndPort}${PROXY_PATH}${replyRoute}`
}

const createLoginHandler = ({ pca, scopes, authReplyRoute }: AuthInput): RequestHandler => {
  const cryptoProvider = new CryptoProvider()

  return (req, res) => {
    cryptoProvider
      .generatePkceCodes()
      .then(({ verifier, challenge }) => {
        const pkceCodes: PKCECodes = {
          challengeMethod: 'S256',
          verifier,
          challenge,
        }

        req.session = { pkceCodes, originalUrl: `${PROXY_PATH}${req.originalUrl}` } as PKCEStartedSession

        return <AuthorizationUrlRequest>{
          scopes,
          redirectUri: createReplyUrl(req, authReplyRoute),
          codeChallenge: pkceCodes.challenge,
          codeChallengeMethod: pkceCodes.challengeMethod,
        }
      })
      .then((authCodeUrlParameters) => pca.getAuthCodeUrl(authCodeUrlParameters))
      .then((response) => res.redirect(response))
      .catch((error: unknown) => {
        throw error
      })
  }
}

type CreateAuthHandlerInput = Pick<AuthConfig, 'scopes' | 'logger' | 'augmentSession'> & {
  pca: PublicClientApplication
  authReplyRoute: string
}

const createAuthHandler = ({ pca, scopes, authReplyRoute, augmentSession, logger }: CreateAuthHandlerInput): RequestHandler => {
  return (req, res) => {
    if (!isPKCEStartedSession(req.session)) throw Error('Invalid session data for this (auth reply) route')

    const {
      originalUrl,
      pkceCodes: { verifier },
    } = req.session

    const tokenRequest: AuthorizationCodeRequest = {
      code: req.query.code as string,
      scopes,
      redirectUri: createReplyUrl(req, authReplyRoute),
      codeVerifier: verifier,
      clientInfo: req.query.client_info as string,
    }

    pca
      .acquireTokenByCode(tokenRequest)
      .then((response) => {
        if (!response) throw new Error('acquireTokenByCode did not return a response')

        let session: AuthenticatedSession = {
          isAuthenticated: true,
          accessToken: response?.accessToken,
        }

        if (augmentSession) session = { ...session, ...augmentSession(response) }

        req.session = session
        res.redirect(originalUrl)

        if (logger) {
          const { authority, uniqueId, tenantId, scopes } = response
          logger?.info('User logged in via PCKE', { authority, uniqueId, tenantId, scopes })
        }
      })
      .catch((error: unknown) => {
        throw error
      })
  }
}

const logoutHandler: RequestHandler = (req, res) => {
  req.session = null
  res.send('🙋🏽‍♀️').end()
}

const setBearerHeaderFromSessionHandler: RequestHandler = (req, _res, next) => {
  const session = req.session
  if (!isAuthenticatedSession(session)) return next()
  req.headers.authorization = `Bearer ${session.accessToken}`
  next()
}

export interface AuthConfig {
  app: Express
  msalConfig: Configuration
  scopes: string[]
  authReplyRoute?: string
  logoutRoute?: string
  protectRoute?: string
  setBearerHeaderRoute?: string
  augmentSession?: (response: AuthenticationResult) => Record<string, unknown> | undefined
  logger?: Logger
}

export interface RequestHandlers {
  ensureAuthenticatedHandler: RequestHandler
  logoutHandler: RequestHandler
  setBearerHeaderFromSessionHandler: RequestHandler
}

export const addPKCEAuthentication = ({
  app,
  msalConfig,
  scopes,
  authReplyRoute = '/auth',
  logoutRoute = '/logout',
  protectRoute = '*',
  setBearerHeaderRoute = '*',
  augmentSession,
  logger,
}: AuthConfig): RequestHandlers => {
  const pca = new PublicClientApplication(msalConfig)

  const ensureAuthenticatedHandler = createEnsureAuthenticatedHandler({ pca, scopes, authReplyRoute })

  app.get(authReplyRoute, createAuthHandler({ pca, scopes, authReplyRoute, augmentSession, logger }))
  logger?.info(`Auth reply handler added to route ${authReplyRoute}`)

  app.get(logoutRoute, logoutHandler)
  logger?.info(`Logout handler added to route ${logoutRoute}`)

  if (protectRoute) {
    app.get(protectRoute, ensureAuthenticatedHandler)
    logger?.info(`PKCE handler (ensureAuthenticatedHandler) added to route GET ${protectRoute}`)
  }

  if (setBearerHeaderRoute) {
    app.post(setBearerHeaderRoute, setBearerHeaderFromSessionHandler)
    logger?.info(`Bearer header setup handler (setBearerHeaderFromSessionHandler) added to route POST ${setBearerHeaderRoute}`)
  }

  return { ensureAuthenticatedHandler, logoutHandler, setBearerHeaderFromSessionHandler }
}

export enum NpmLogLevel {
  error = 0,
  warn = 1,
  info = 2,
  http = 3,
  verbose = 4,
  debug = 5,
  silly = 6,
}

export const toNpmLogLevel = (level: LogLevel): keyof typeof NpmLogLevel => {
  switch (level) {
    case LogLevel.Error:
      return 'error'
    case LogLevel.Warning:
      return 'warn'
    case LogLevel.Info:
      return 'info'
    case LogLevel.Verbose:
      return 'verbose'
    case LogLevel.Trace:
      return 'debug'
  }
}

export { Configuration, AuthenticationResult }