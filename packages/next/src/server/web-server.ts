import type { WebNextRequest, WebNextResponse } from './base-http/web'
import type { RenderOpts } from './render'
import type RenderResult from './render-result'
import type { NextParsedUrlQuery, NextUrlWithParsedQuery } from './request-meta'
import type { Params } from '../shared/lib/router/utils/route-matcher'
import type { PayloadOptions } from './send-payload'
import type { LoadComponentsReturnType } from './load-components'
import type { BaseNextRequest, BaseNextResponse } from './base-http'
import type { UrlWithParsedQuery } from 'url'

import { byteLength } from './api-utils/web'
import BaseServer, {
  MiddlewareRoutingItem,
  NoFallbackError,
  Options,
  NormalizedRouteManifest,
} from './base-server'
import { generateETag } from './lib/etag'
import { addRequestMeta } from './request-meta'
import WebResponseCache from './response-cache/web'
import { isAPIRoute } from '../lib/is-api-route'
import { removeTrailingSlash } from '../shared/lib/router/utils/remove-trailing-slash'
import { isDynamicRoute } from '../shared/lib/router/utils'
import { interpolateDynamicPath, normalizeVercelUrl } from './server-utils'
import { getNamedRouteRegex } from '../shared/lib/router/utils/route-regex'
import { IncrementalCache } from './lib/incremental-cache'
import { PrerenderManifest } from '../build'

interface WebServerOptions extends Options {
  webServerConfig: {
    page: string
    normalizedPage: string
    pagesType: 'app' | 'pages' | 'root'
    loadComponent: (
      pathname: string
    ) => Promise<LoadComponentsReturnType | null>
    extendRenderOpts: Partial<BaseServer['renderOpts']> &
      Pick<BaseServer['renderOpts'], 'buildId'>
    renderToHTML:
      | typeof import('./app-render/app-render').renderToHTMLOrFlight
      | undefined
    incrementalCacheHandler?: any
    prerenderManifest: PrerenderManifest | undefined
  }
}

export default class NextWebServer extends BaseServer<WebServerOptions> {
  constructor(options: WebServerOptions) {
    super(options)

    // Extend `renderOpts`.
    Object.assign(this.renderOpts, options.webServerConfig.extendRenderOpts)
  }

  protected async handleUpgrade(): Promise<void> {
    // The web server does not support web sockets.
  }

  protected handleCompression() {
    // For the web server layer, compression is automatically handled by the
    // upstream proxy (edge runtime or node server) and we can simply skip here.
  }

  protected getMiddleware(): MiddlewareRoutingItem | undefined {
    // The web server does not need to handle middleware. This is done by the
    // upstream proxy (edge runtime or node server).
    return undefined
  }

  protected async getFallbackErrorComponents(): Promise<LoadComponentsReturnType | null> {
    // The web server does not need to handle fallback errors in production.
    return null
  }

  protected getRoutesManifest(): NormalizedRouteManifest | undefined {
    // The web server does not need to handle rewrite rules. This is done by the
    // upstream proxy (edge runtime or node server).
    return undefined
  }

  protected getIncrementalCache({
    requestHeaders,
  }: {
    requestHeaders: IncrementalCache['requestHeaders']
  }) {
    const dev = !!this.renderOpts.dev
    // incremental-cache is request specific
    // although can have shared caches in module scope
    // per-cache handler
    return new IncrementalCache({
      dev,
      requestHeaders,
      requestProtocol: 'https',
      appDir: this.hasAppDir,
      allowedRevalidateHeaderKeys:
        this.nextConfig.experimental.allowedRevalidateHeaderKeys,
      minimalMode: this.minimalMode,
      fetchCache: this.nextConfig.experimental.appDir,
      fetchCacheKeyPrefix: this.nextConfig.experimental.fetchCacheKeyPrefix,
      maxMemoryCacheSize: this.nextConfig.experimental.isrMemoryCacheSize,
      flushToDisk: false,
      CurCacheHandler:
        this.serverOptions.webServerConfig.incrementalCacheHandler,
      getPrerenderManifest: () => this.getPrerenderManifest(),
    })
  }
  protected getResponseCache() {
    return new WebResponseCache(this.minimalMode)
  }
  protected getCustomRoutes() {
    return {
      headers: [],
      rewrites: {
        fallback: [],
        afterFiles: [],
        beforeFiles: [],
      },
      redirects: [],
    }
  }
  protected async run(
    req: BaseNextRequest,
    res: BaseNextResponse,
    parsedUrl: UrlWithParsedQuery
  ): Promise<void> {
    super.run(req, res, parsedUrl)
  }
  protected async hasPage(page: string) {
    return page === this.serverOptions.webServerConfig.page
  }
  protected getPublicDir() {
    // Public files are not handled by the web server.
    return ''
  }
  protected getBuildId() {
    return this.serverOptions.webServerConfig.extendRenderOpts.buildId
  }
  protected loadEnvConfig() {
    // The web server does not need to load the env config. This is done by the
    // runtime already.
  }
  protected getHasAppDir() {
    return this.serverOptions.webServerConfig.pagesType === 'app'
  }
  protected getHasStaticDir() {
    return false
  }
  protected async getFallback() {
    return ''
  }
  protected getFontManifest() {
    return undefined
  }
  protected getPagesManifest() {
    return {
      // keep same theme but server path doesn't need to be accurate
      [this.serverOptions.webServerConfig
        .normalizedPage]: `server${this.serverOptions.webServerConfig.page}.js`,
    }
  }
  protected getAppPathsManifest() {
    const page = this.serverOptions.webServerConfig.page
    return {
      [this.serverOptions.webServerConfig.page]: `app${page}.js`,
    }
  }
  protected getFilesystemPaths() {
    return new Set<string>()
  }
  protected attachRequestMeta(
    req: WebNextRequest,
    parsedUrl: NextUrlWithParsedQuery
  ) {
    addRequestMeta(req, '__NEXT_INIT_QUERY', { ...parsedUrl.query })
  }
  protected getPrerenderManifest() {
    const { prerenderManifest } = this.serverOptions.webServerConfig
    if (this.renderOpts?.dev || !prerenderManifest) {
      return {
        version: -1 as any, // letting us know this doesn't conform to spec
        routes: {},
        dynamicRoutes: {},
        notFoundRoutes: [],
        preview: {
          previewModeId: 'development-id',
        } as any, // `preview` is special case read in next-dev-server
      }
    }
    return prerenderManifest
  }

  protected getNextFontManifest() {
    return this.serverOptions.webServerConfig.extendRenderOpts.nextFontManifest
  }

  protected async handleCatchallRenderRequest(
    req: BaseNextRequest,
    res: BaseNextResponse,
    parsedUrl: NextUrlWithParsedQuery
  ): Promise<{ finished: boolean }> {
    let { pathname, query } = parsedUrl
    if (!pathname) {
      throw new Error('pathname is undefined')
    }

    // interpolate query information into page for dynamic route
    // so that rewritten paths are handled properly
    const normalizedPage = this.serverOptions.webServerConfig.normalizedPage

    if (pathname !== normalizedPage) {
      pathname = normalizedPage

      if (isDynamicRoute(pathname)) {
        const routeRegex = getNamedRouteRegex(pathname, false)
        pathname = interpolateDynamicPath(pathname, query, routeRegex)
        normalizeVercelUrl(
          req,
          true,
          Object.keys(routeRegex.routeKeys),
          true,
          routeRegex
        )
      }
    }

    // next.js core assumes page path without trailing slash
    pathname = removeTrailingSlash(pathname)

    if (this.i18nProvider) {
      const { detectedLocale } = await this.i18nProvider.analyze(pathname)
      if (detectedLocale) {
        parsedUrl.query.__nextLocale = detectedLocale
      }
    }

    const bubbleNoFallback = !!query._nextBubbleNoFallback

    if (isAPIRoute(pathname)) {
      delete query._nextBubbleNoFallback
    }

    try {
      await this.render(req, res, pathname, query, parsedUrl, true)

      return {
        finished: true,
      }
    } catch (err) {
      if (err instanceof NoFallbackError && bubbleNoFallback) {
        return {
          finished: false,
        }
      }
      throw err
    }
  }

  // Edge API requests are handled separately in minimal mode.
  protected async handleApiRequest() {
    return false
  }

  protected renderHTML(
    req: WebNextRequest,
    res: WebNextResponse,
    pathname: string,
    query: NextParsedUrlQuery,
    renderOpts: RenderOpts
  ): Promise<RenderResult> {
    const { renderToHTML } = this.serverOptions.webServerConfig
    if (!renderToHTML) {
      throw new Error(
        'Invariant: routeModule should be configured when rendering pages'
      )
    }

    // For edge runtime if the pathname hit as /_not-found entrypoint,
    // override the pathname to /404 for rendering
    if (pathname === (renderOpts.dev ? '/not-found' : '/_not-found')) {
      pathname = '/404'
    }
    return renderToHTML(
      req as any,
      res as any,
      pathname,
      query,
      Object.assign(renderOpts, {
        disableOptimizedLoading: true,
        runtime: 'experimental-edge',
      })
    )
  }

  protected async sendRenderResult(
    _req: WebNextRequest,
    res: WebNextResponse,
    options: {
      result: RenderResult
      type: 'html' | 'json'
      generateEtags: boolean
      poweredByHeader: boolean
      options?: PayloadOptions | undefined
    }
  ): Promise<void> {
    res.setHeader('X-Edge-Runtime', '1')

    // Add necessary headers.
    // @TODO: Share the isomorphic logic with server/send-payload.ts.
    if (options.poweredByHeader && options.type === 'html') {
      res.setHeader('X-Powered-By', 'Next.js')
    }

    if (!res.getHeader('Content-Type')) {
      res.setHeader(
        'Content-Type',
        options.result.contentType
          ? options.result.contentType
          : options.type === 'json'
          ? 'application/json'
          : 'text/html; charset=utf-8'
      )
    }

    if (options.result.isDynamic) {
      const writer = res.transformStream.writable.getWriter()

      let innerClose: undefined | (() => void)
      const target = {
        write: (chunk: Uint8Array) => writer.write(chunk),
        end: () => writer.close(),

        on(_event: 'close', cb: () => void) {
          innerClose = cb
        },
        off(_event: 'close', _cb: () => void) {
          innerClose = undefined
        },
      }
      const onClose = () => {
        innerClose?.()
      }
      // No, this cannot be replaced with `finally`, because early cancelling
      // the stream will create a rejected promise, and finally will create an
      // unhandled rejection.
      writer.closed.then(onClose, onClose)
      options.result.pipe(target)
    } else {
      const payload = await options.result.toUnchunkedString()
      res.setHeader('Content-Length', String(byteLength(payload)))
      if (options.generateEtags) {
        res.setHeader('ETag', generateETag(payload))
      }
      res.body(payload)
    }

    res.send()
  }
  protected async runApi() {
    // @TODO
    return true
  }

  protected async findPageComponents({
    pathname,
    query,
    params,
  }: {
    pathname: string
    query: NextParsedUrlQuery
    params: Params | null
    isAppPath: boolean
  }) {
    const result = await this.serverOptions.webServerConfig.loadComponent(
      pathname
    )
    if (!result) return null

    return {
      query: {
        ...(query || {}),
        ...(params || {}),
      },
      components: result,
    }
  }
}
