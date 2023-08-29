import type { NextConfigComplete } from '../../config-shared'
import type {
  Endpoint,
  Route,
  TurbopackResult,
  WrittenEndpoint,
} from '../../../build/swc'

import fs from 'fs'
import url from 'url'
import path from 'path'
import qs from 'querystring'
import Watchpack from 'watchpack'
import { loadEnvConfig } from '@next/env'
import isError from '../../../lib/is-error'
import findUp from 'next/dist/compiled/find-up'
import { FilesystemDynamicRoute, buildCustomRoute } from './filesystem'
import * as Log from '../../../build/output/log'
import HotReloader, {
  matchNextPageBundleRequest,
} from '../../dev/hot-reloader-webpack'
import { setGlobal } from '../../../trace/shared'
import { Telemetry } from '../../../telemetry/storage'
import { IncomingMessage, ServerResponse } from 'http'
import loadJsConfig from '../../../build/load-jsconfig'
import { createValidFileMatcher } from '../find-page-file'
import { eventCliSession } from '../../../telemetry/events'
import { getDefineEnv } from '../../../build/webpack-config'
import { logAppDirError } from '../../dev/log-app-dir-error'
import { UnwrapPromise } from '../../../lib/coalesced-function'
import { getSortedRoutes } from '../../../shared/lib/router/utils'
import {
  getStaticInfoIncludingLayouts,
  sortByPageExts,
} from '../../../build/entries'
import { verifyTypeScriptSetup } from '../../../lib/verifyTypeScriptSetup'
import { verifyPartytownSetup } from '../../../lib/verify-partytown-setup'
import { getRouteRegex } from '../../../shared/lib/router/utils/route-regex'
import { normalizeAppPath } from '../../../shared/lib/router/utils/app-paths'
import { buildDataRoute } from './build-data-route'
import { MiddlewareMatcher } from '../../../build/analysis/get-page-static-info'
import { getRouteMatcher } from '../../../shared/lib/router/utils/route-matcher'
import { normalizePathSep } from '../../../shared/lib/page-path/normalize-path-sep'
import { createClientRouterFilter } from '../../../lib/create-client-router-filter'
import { absolutePathToPage } from '../../../shared/lib/page-path/absolute-path-to-page'
import { generateInterceptionRoutesRewrites } from '../../../lib/generate-interception-routes-rewrites'

import {
  APP_BUILD_MANIFEST,
  APP_PATHS_MANIFEST,
  BUILD_MANIFEST,
  CLIENT_STATIC_FILES_PATH,
  COMPILER_NAMES,
  DEV_CLIENT_PAGES_MANIFEST,
  DEV_MIDDLEWARE_MANIFEST,
  MIDDLEWARE_MANIFEST,
  NEXT_FONT_MANIFEST,
  PAGES_MANIFEST,
  PHASE_DEVELOPMENT_SERVER,
} from '../../../shared/lib/constants'

import {
  MiddlewareRouteMatch,
  getMiddlewareRouteMatcher,
} from '../../../shared/lib/router/utils/middleware-route-matcher'
import { NextBuildContext } from '../../../build/build-context'

import {
  isMiddlewareFile,
  NestedMiddlewareError,
  isInstrumentationHookFile,
  getPossibleMiddlewareFilenames,
  getPossibleInstrumentationHookFilenames,
} from '../../../build/worker'
import {
  createOriginalStackFrame,
  getErrorSource,
  getSourceById,
  parseStack,
} from 'next/dist/compiled/@next/react-dev-overlay/dist/middleware'
import { BuildManifest } from '../../get-page-files'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { PagesManifest } from '../../../build/webpack/plugins/pages-manifest-plugin'
import { AppBuildManifest } from '../../../build/webpack/plugins/app-build-manifest-plugin'
import { PageNotFoundError } from '../../../shared/lib/utils'
import { srcEmptySsgManifest } from '../../../build/webpack/plugins/build-manifest-plugin'
import { PropagateToWorkersField } from './types'
import { MiddlewareManifest } from '../../../build/webpack/plugins/middleware-plugin'
import { devPageFiles } from '../../../build/webpack/plugins/next-types-plugin/shared'
import type { RenderWorkers } from '../router-server'
import { pathToRegexp } from 'next/dist/compiled/path-to-regexp'
import { NextJsHotReloaderInterface } from '../../dev/hot-reloader-types'
import { isAPIRoute } from '../../../lib/is-api-route'

type SetupOpts = {
  renderWorkers: RenderWorkers
  dir: string
  turbo?: boolean
  appDir?: string
  pagesDir?: string
  telemetry: Telemetry
  isCustomServer?: boolean
  fsChecker: UnwrapPromise<
    ReturnType<typeof import('./filesystem').setupFsCheck>
  >
  nextConfig: NextConfigComplete
}

async function verifyTypeScript(opts: SetupOpts) {
  let usingTypeScript = false
  const verifyResult = await verifyTypeScriptSetup({
    dir: opts.dir,
    distDir: opts.nextConfig.distDir,
    intentDirs: [opts.pagesDir, opts.appDir].filter(Boolean) as string[],
    typeCheckPreflight: false,
    tsconfigPath: opts.nextConfig.typescript.tsconfigPath,
    disableStaticImages: opts.nextConfig.images.disableStaticImages,
    hasAppDir: !!opts.appDir,
    hasPagesDir: !!opts.pagesDir,
  })

  if (verifyResult.version) {
    usingTypeScript = true
  }
  return usingTypeScript
}

async function startWatcher(opts: SetupOpts) {
  const { nextConfig, appDir, pagesDir, dir } = opts
  const { useFileSystemPublicRoutes } = nextConfig
  const usingTypeScript = await verifyTypeScript(opts)

  const distDir = path.join(opts.dir, opts.nextConfig.distDir)

  setGlobal('distDir', distDir)
  setGlobal('phase', PHASE_DEVELOPMENT_SERVER)

  const validFileMatcher = createValidFileMatcher(
    nextConfig.pageExtensions,
    appDir
  )

  async function propagateToWorkers(field: PropagateToWorkersField, args: any) {
    await opts.renderWorkers.app?.propagateServerField(field, args)
    await opts.renderWorkers.pages?.propagateServerField(field, args)
  }

  const serverFields: {
    actualMiddlewareFile?: string | undefined
    actualInstrumentationHookFile?: string | undefined
    appPathRoutes?: Record<string, string | string[]>
    middleware?:
      | {
          page: string
          match: MiddlewareRouteMatch
          matchers?: MiddlewareMatcher[]
        }
      | undefined
    hasAppNotFound?: boolean
    interceptionRoutes?: ReturnType<
      typeof import('./filesystem').buildCustomRoute
    >[]
  } = {}

  let hotReloader: NextJsHotReloaderInterface

  if (opts.turbo) {
    const { loadBindings } =
      require('../../../build/swc') as typeof import('../../../build/swc')

    let bindings = await loadBindings()

    const { jsConfig } = await loadJsConfig(dir, opts.nextConfig)

    const project = await bindings.turbo.createProject({
      projectPath: dir,
      rootPath: opts.nextConfig.experimental.outputFileTracingRoot || dir,
      nextConfig: opts.nextConfig,
      jsConfig,
      watch: true,
      env: process.env as Record<string, string>,
    })
    const iter = project.entrypointsSubscribe()
    const curEntries: Map<string, Route> = new Map()
    const globalEntries: {
      app: Endpoint | undefined
      document: Endpoint | undefined
      error: Endpoint | undefined
    } = {
      app: undefined,
      document: undefined,
      error: undefined,
    }
    let currentEntriesHandlingResolve: ((value?: unknown) => void) | undefined
    let currentEntriesHandling = new Promise(
      (resolve) => (currentEntriesHandlingResolve = resolve)
    )

    const issues = new Map<string, Set<string>>()

    async function processResult(
      key: string,
      result: TurbopackResult<WrittenEndpoint> | undefined
    ): Promise<TurbopackResult<WrittenEndpoint> | undefined> {
      if (result) {
        await (global as any)._nextDeleteCache?.(
          result.serverPaths
            .map((p) => path.join(distDir, p))
            .concat([
              // We need to clear the chunk cache in react
              require.resolve(
                'next/dist/compiled/react-server-dom-webpack/cjs/react-server-dom-webpack-client.edge.development.js'
              ),
              // And this redirecting module as well
              require.resolve(
                'next/dist/compiled/react-server-dom-webpack/client.edge.js'
              ),
            ])
        )

        const oldSet = issues.get(key) ?? new Set()
        const newSet = new Set<string>()

        for (const issue of result.issues) {
          // TODO better formatting
          if (issue.severity !== 'error' && issue.severity !== 'fatal') continue
          const issueKey = `${issue.severity} - ${issue.filePath} - ${issue.title}\n${issue.description}\n\n`
          if (!oldSet.has(issueKey)) {
            console.error(
              `  ⚠ ${key} ${issue.severity} - ${
                issue.filePath
              }\n    ${issue.title.replace(
                /\n/g,
                '\n    '
              )}\n    ${issue.description.replace(/\n/g, '\n    ')}\n\n`
            )
          }
          newSet.add(issueKey)
        }
        for (const issue of oldSet) {
          if (!newSet.has(issue)) {
            console.error(`✅ ${key} fixed ${issue}`)
          }
        }

        issues.set(key, newSet)
      }
      return result
    }

    const clearCache = (filePath: string) =>
      (global as any)._nextDeleteCache?.([filePath])

    async function loadPartialManifest<T>(
      name: string,
      pageName: string,
      type: 'pages' | 'app' | 'app-route' | 'middleware' = 'pages'
    ): Promise<T> {
      const manifestPath = path.posix.join(
        distDir,
        `server`,
        type === 'app-route' ? 'app' : type,
        type === 'middleware'
          ? ''
          : pageName === '/' && type === 'pages'
          ? 'index'
          : pageName,
        pageName === '/_not-found' || pageName === '/not-found'
          ? ''
          : type === 'app'
          ? 'page'
          : type === 'app-route'
          ? 'route'
          : '',
        name
      )
      return JSON.parse(
        await readFile(path.posix.join(manifestPath), 'utf-8')
      ) as T
    }

    const buildManifests = new Map<string, BuildManifest>()
    const appBuildManifests = new Map<string, AppBuildManifest>()
    const pagesManifests = new Map<string, PagesManifest>()
    const appPathsManifests = new Map<string, PagesManifest>()
    const middlewareManifests = new Map<string, MiddlewareManifest>()

    async function loadMiddlewareManifest(
      pageName: string,
      type: 'pages' | 'app' | 'app-route' | 'middleware'
    ): Promise<void> {
      middlewareManifests.set(
        pageName,
        await loadPartialManifest(MIDDLEWARE_MANIFEST, pageName, type)
      )
    }

    async function loadBuildManifest(
      pageName: string,
      type: 'app' | 'pages' = 'pages'
    ): Promise<void> {
      buildManifests.set(
        pageName,
        await loadPartialManifest(BUILD_MANIFEST, pageName, type)
      )
    }

    async function loadAppBuildManifest(pageName: string): Promise<void> {
      appBuildManifests.set(
        pageName,
        await loadPartialManifest(APP_BUILD_MANIFEST, pageName, 'app')
      )
    }

    async function loadPagesManifest(pageName: string): Promise<void> {
      pagesManifests.set(
        pageName,
        await loadPartialManifest(PAGES_MANIFEST, pageName)
      )
    }

    async function loadAppPathManifest(
      pageName: string,
      type: 'app' | 'app-route' = 'app'
    ): Promise<void> {
      appPathsManifests.set(
        pageName,
        await loadPartialManifest(APP_PATHS_MANIFEST, pageName, type)
      )
    }

    try {
      async function handleEntries() {
        for await (const entrypoints of iter) {
          if (!currentEntriesHandlingResolve) {
            currentEntriesHandling = new Promise(
              // eslint-disable-next-line no-loop-func
              (resolve) => (currentEntriesHandlingResolve = resolve)
            )
          }
          globalEntries.app = entrypoints.pagesAppEndpoint
          globalEntries.document = entrypoints.pagesDocumentEndpoint
          globalEntries.error = entrypoints.pagesErrorEndpoint

          curEntries.clear()

          for (const [pathname, route] of entrypoints.routes) {
            switch (route.type) {
              case 'page':
              case 'page-api':
              case 'app-page':
              case 'app-route': {
                curEntries.set(pathname, route)
                break
              }
              default:
                Log.info(`skipping ${pathname} (${route.type})`)
                break
            }
          }

          if (entrypoints.middleware) {
            await processResult(
              'middleware',
              await entrypoints.middleware.endpoint.writeToDisk()
            )
            await loadMiddlewareManifest('middleware', 'middleware')
            serverFields.actualMiddlewareFile = 'middleware'
            serverFields.middleware = {
              match: null as any,
              page: '/',
              matchers:
                middlewareManifests.get('middleware')?.middleware['/'].matchers,
            }
          } else {
            middlewareManifests.delete('middleware')
            serverFields.actualMiddlewareFile = undefined
            serverFields.middleware = undefined
          }
          await propagateToWorkers(
            'actualMiddlewareFile',
            serverFields.actualMiddlewareFile
          )
          await propagateToWorkers('middleware', serverFields.middleware)

          currentEntriesHandlingResolve!()
          currentEntriesHandlingResolve = undefined
        }
      }
      handleEntries().catch((err) => {
        console.error(err)
        process.exit(1)
      })
    } catch (e) {
      console.error(e)
    }

    function mergeBuildManifests(manifests: Iterable<BuildManifest>) {
      const manifest: Partial<BuildManifest> & Pick<BuildManifest, 'pages'> = {
        pages: {
          '/_app': [],
        },
        // Something in next.js depends on these to exist even for app dir rendering
        devFiles: [],
        ampDevFiles: [],
        polyfillFiles: [],
        lowPriorityFiles: [
          'static/development/_ssgManifest.js',
          'static/development/_buildManifest.js',
        ],
        rootMainFiles: [],
        ampFirstPages: [],
      }
      for (const m of manifests) {
        Object.assign(manifest.pages, m.pages)
        if (m.rootMainFiles.length) manifest.rootMainFiles = m.rootMainFiles
      }
      return manifest
    }

    function mergeAppBuildManifests(manifests: Iterable<AppBuildManifest>) {
      const manifest: AppBuildManifest = {
        pages: {},
      }
      for (const m of manifests) {
        Object.assign(manifest.pages, m.pages)
      }
      return manifest
    }

    function mergePagesManifests(manifests: Iterable<PagesManifest>) {
      const manifest: PagesManifest = {}
      for (const m of manifests) {
        Object.assign(manifest, m)
      }
      return manifest
    }

    function mergeMiddlewareManifests(
      manifests: Iterable<MiddlewareManifest>
    ): MiddlewareManifest {
      const manifest: MiddlewareManifest = {
        version: 2,
        middleware: {},
        sortedMiddleware: [],
        functions: {},
      }
      for (const m of manifests) {
        Object.assign(manifest.functions, m.functions)
        Object.assign(manifest.middleware, m.middleware)
      }
      for (const fun of Object.values(manifest.functions).concat(
        Object.values(manifest.middleware)
      )) {
        for (const matcher of fun.matchers) {
          if (!matcher.regexp) {
            matcher.regexp = pathToRegexp(matcher.originalSource, [], {
              delimiter: '/',
              sensitive: false,
              strict: true,
            }).source.replaceAll('\\/', '/')
          }
        }
      }
      manifest.sortedMiddleware = Object.keys(manifest.middleware)
      return manifest
    }

    async function writeBuildManifest(): Promise<void> {
      const buildManifest = mergeBuildManifests(buildManifests.values())
      const buildManifestPath = path.join(distDir, 'build-manifest.json')
      await clearCache(buildManifestPath)
      await writeFile(
        buildManifestPath,
        JSON.stringify(buildManifest, null, 2),
        'utf-8'
      )
      const content = {
        __rewrites: { afterFiles: [], beforeFiles: [], fallback: [] },
        ...Object.fromEntries(
          [...curEntries.keys()].map((pathname) => [
            pathname,
            `static/chunks/pages${pathname === '/' ? '/index' : pathname}.js`,
          ])
        ),
        sortedPages: [...curEntries.keys()],
      }
      const buildManifestJs = `self.__BUILD_MANIFEST = ${JSON.stringify(
        content
      )};self.__BUILD_MANIFEST_CB && self.__BUILD_MANIFEST_CB()`
      await writeFile(
        path.join(distDir, 'static', 'development', '_buildManifest.js'),
        buildManifestJs,
        'utf-8'
      )
      await writeFile(
        path.join(distDir, 'static', 'development', '_ssgManifest.js'),
        srcEmptySsgManifest,
        'utf-8'
      )
    }

    async function writeAppBuildManifest(): Promise<void> {
      const appBuildManifest = mergeAppBuildManifests(
        appBuildManifests.values()
      )
      const appBuildManifestPath = path.join(distDir, APP_BUILD_MANIFEST)
      await clearCache(appBuildManifestPath)
      await writeFile(
        appBuildManifestPath,
        JSON.stringify(appBuildManifest, null, 2),
        'utf-8'
      )
    }

    async function writePagesManifest(): Promise<void> {
      const pagesManifest = mergePagesManifests(pagesManifests.values())
      const pagesManifestPath = path.join(distDir, 'server', PAGES_MANIFEST)
      await clearCache(pagesManifestPath)
      await writeFile(
        pagesManifestPath,
        JSON.stringify(pagesManifest, null, 2),
        'utf-8'
      )
    }

    async function writeAppPathsManifest(): Promise<void> {
      const appPathsManifest = mergePagesManifests(appPathsManifests.values())
      const appPathsManifestPath = path.join(
        distDir,
        'server',
        APP_PATHS_MANIFEST
      )
      await clearCache(appPathsManifestPath)
      await writeFile(
        appPathsManifestPath,
        JSON.stringify(appPathsManifest, null, 2),
        'utf-8'
      )
    }

    async function writeMiddlewareManifest(): Promise<void> {
      const middlewareManifest = mergeMiddlewareManifests(
        middlewareManifests.values()
      )
      const middlewareManifestPath = path.join(
        distDir,
        'server/middleware-manifest.json'
      )
      await clearCache(middlewareManifestPath)
      await writeFile(
        middlewareManifestPath,
        JSON.stringify(middlewareManifest, null, 2),
        'utf-8'
      )
    }

    async function writeOtherManifests(): Promise<void> {
      const loadableManifestPath = path.join(
        distDir,
        'react-loadable-manifest.json'
      )
      await clearCache(loadableManifestPath)
      await writeFile(
        loadableManifestPath,
        JSON.stringify({}, null, 2),
        'utf-8'
      )
      // TODO: turbopack should write the correct
      // version of this
      const fontManifestPath = path.join(
        distDir,
        'server',
        NEXT_FONT_MANIFEST + '.json'
      )
      await clearCache(fontManifestPath)
      await writeFile(
        fontManifestPath,
        JSON.stringify(
          {
            pages: {},
            app: {},
            appUsingSizeAdjust: false,
            pagesUsingSizeAdjust: false,
          },
          null,
          2
        )
      )
    }

    // Write empty manifests
    await mkdir(path.join(distDir, 'server'), { recursive: true })
    await mkdir(path.join(distDir, 'static/development'), { recursive: true })
    await writeFile(
      path.join(distDir, 'package.json'),
      JSON.stringify(
        {
          type: 'commonjs',
        },
        null,
        2
      )
    )
    await currentEntriesHandling
    await writeBuildManifest()
    await writeAppBuildManifest()
    await writePagesManifest()
    await writeAppPathsManifest()
    await writeMiddlewareManifest()
    await writeOtherManifests()

    const turbopackHotReloader: NextJsHotReloaderInterface = {
      activeWebpackConfigs: undefined,
      serverStats: null,
      edgeServerStats: null,
      async run(req, _res, _parsedUrl) {
        // intercept page chunks request and ensure them with turbopack
        if (req.url?.startsWith('/_next/static/chunks/pages/')) {
          const params = matchNextPageBundleRequest(req.url)

          if (params) {
            const decodedPagePath = `/${params.path
              .map((param: string) => decodeURIComponent(param))
              .join('/')}`

            await hotReloader
              .ensurePage({
                page: decodedPagePath,
                clientOnly: false,
              })
              .catch(console.error)
          }
        }
        // Request was not finished.
        return { finished: undefined }
      },

      setHmrServerError(_error) {
        // Not implemented yet.
      },
      clearHmrServerError() {
        // Not implemented yet.
      },
      async start() {
        // Not implemented yet.
      },
      async stop() {
        // Not implemented yet.
      },
      send(_action, ..._args) {
        // Not implemented yet.
      },
      async getCompilationErrors(_page) {
        return []
      },
      onHMR(_req, _socket, _head) {
        // Not implemented yet.
      },
      invalidate(/* Unused parameter: { reloadAfterInvalidation } */) {
        // Not implemented yet.
      },
      async buildFallbackError() {
        // Not implemented yet.
      },
      async ensurePage({
        page: inputPage,
        // Unused parameters
        // clientOnly,
        // appPaths,
        match,
        isApp,
      }) {
        let page = match?.definition?.pathname ?? inputPage

        if (page === '/_error') {
          await processResult('_app', await globalEntries.app?.writeToDisk())
          await loadBuildManifest('_app')
          await loadPagesManifest('_app')

          await processResult(
            '_document',
            await globalEntries.document?.writeToDisk()
          )
          await loadPagesManifest('_document')

          await processResult(page, await globalEntries.error?.writeToDisk())
          await loadBuildManifest('_error')
          await loadPagesManifest('_error')

          await writeBuildManifest()
          await writePagesManifest()
          await writeMiddlewareManifest()
          await writeOtherManifests()

          return
        }

        await currentEntriesHandling
        const route = curEntries.get(page)

        if (!route) {
          // TODO: why is this entry missing in turbopack?
          if (page === '/_app') return
          if (page === '/_document') return
          if (page === '/middleware') return

          throw new PageNotFoundError(`route not found ${page}`)
        }

        switch (route.type) {
          case 'page': {
            if (isApp) {
              throw new Error(
                `mis-matched route type: isApp && page for ${page}`
              )
            }

            await processResult('_app', await globalEntries.app?.writeToDisk())
            await loadBuildManifest('_app')
            await loadPagesManifest('_app')

            await processResult(
              '_document',
              await globalEntries.document?.writeToDisk()
            )
            await loadPagesManifest('_document')

            const writtenEndpoint = await processResult(
              page,
              await route.htmlEndpoint.writeToDisk()
            )

            const type = writtenEndpoint?.type

            await loadBuildManifest(page)
            await loadPagesManifest(page)
            if (type === 'edge') {
              await loadMiddlewareManifest(page, 'pages')
            } else {
              middlewareManifests.delete(page)
            }

            await writeBuildManifest()
            await writePagesManifest()
            await writeMiddlewareManifest()
            await writeOtherManifests()

            break
          }
          case 'page-api': {
            // We don't throw on ensureOpts.isApp === true here
            // since this can happen when app pages make
            // api requests to page API routes.

            const writtenEndpoint = await processResult(
              page,
              await route.endpoint.writeToDisk()
            )

            const type = writtenEndpoint?.type

            await loadPagesManifest(page)
            if (type === 'edge') {
              await loadMiddlewareManifest(page, 'pages')
            } else {
              middlewareManifests.delete(page)
            }

            await writePagesManifest()
            await writeMiddlewareManifest()
            await writeOtherManifests()

            break
          }
          case 'app-page': {
            await processResult(page, await route.htmlEndpoint.writeToDisk())

            await loadAppBuildManifest(page)
            await loadBuildManifest(page, 'app')
            await loadAppPathManifest(page, 'app')

            await writeAppBuildManifest()
            await writeBuildManifest()
            await writeAppPathsManifest()
            await writeMiddlewareManifest()
            await writeOtherManifests()

            break
          }
          case 'app-route': {
            const type = (
              await processResult(page, await route.endpoint.writeToDisk())
            )?.type

            await loadAppPathManifest(page, 'app-route')
            if (type === 'edge') {
              await loadMiddlewareManifest(page, 'app-route')
            } else {
              middlewareManifests.delete(page)
            }

            await writeAppBuildManifest()
            await writeAppPathsManifest()
            await writeMiddlewareManifest()
            await writeMiddlewareManifest()
            await writeOtherManifests()

            break
          }
          default: {
            throw new Error(`unknown route type ${route.type} for ${page}`)
          }
        }
      },
    }

    hotReloader = turbopackHotReloader
  } else {
    hotReloader = new HotReloader(opts.dir, {
      appDir,
      pagesDir,
      distDir: distDir,
      config: opts.nextConfig,
      buildId: 'development',
      telemetry: opts.telemetry,
      rewrites: opts.fsChecker.rewrites,
      previewProps: opts.fsChecker.prerenderManifest.preview,
    })
  }

  await hotReloader.start()

  if (opts.nextConfig.experimental.nextScriptWorkers) {
    await verifyPartytownSetup(
      opts.dir,
      path.join(distDir, CLIENT_STATIC_FILES_PATH)
    )
  }

  opts.fsChecker.ensureCallback(async function ensure(item) {
    if (item.type === 'appFile' || item.type === 'pageFile') {
      // If the type is an app file, then we should mark it as an app page.
      const isApp = item.type === 'appFile'

      // If this is an app file, then we should get the associated app paths
      // for this file.
      let page = item.itemPath
      let itemAppPaths: ReadonlyArray<string> | undefined
      if (isApp) {
        itemAppPaths = opts.fsChecker.appPaths.get(item.itemPath)
        page = opts.fsChecker.appPages.get(page) ?? page
      }

      await hotReloader.ensurePage({
        isApp,
        appPaths: itemAppPaths,
        page,
        clientOnly: false,
      })

      // Reload the matchers.
      // TODO: only reload the matchers for the type that changed, ie, only reload the app worker for app pages
      await propagateToWorkers('reloadMatchers', undefined)
    }
  })

  let resolved = false
  let prevSortedRoutes: string[] = []

  await new Promise<void>(async (resolve, reject) => {
    if (pagesDir) {
      // Watchpack doesn't emit an event for an empty directory
      fs.readdir(pagesDir, (_, files) => {
        if (files?.length) {
          return
        }

        if (!resolved) {
          resolve()
          resolved = true
        }
      })
    }

    const pages = pagesDir ? [pagesDir] : []
    const app = appDir ? [appDir] : []
    const directories = [...pages, ...app]

    const rootDir = pagesDir || appDir
    const files = [
      ...getPossibleMiddlewareFilenames(
        path.join(rootDir!, '..'),
        nextConfig.pageExtensions
      ),
      ...getPossibleInstrumentationHookFilenames(
        path.join(rootDir!, '..'),
        nextConfig.pageExtensions
      ),
    ]
    let nestedMiddleware: string[] = []

    const envFiles = [
      '.env.development.local',
      '.env.local',
      '.env.development',
      '.env',
    ].map((file) => path.join(dir, file))

    files.push(...envFiles)

    // tsconfig/jsconfig paths hot-reloading
    const tsconfigPaths = [
      path.join(dir, 'tsconfig.json'),
      path.join(dir, 'jsconfig.json'),
    ]
    files.push(...tsconfigPaths)

    const wp = new Watchpack({
      ignored: (pathname: string) => {
        return (
          !files.some((file) => file.startsWith(pathname)) &&
          !directories.some(
            (d) => pathname.startsWith(d) || d.startsWith(pathname)
          )
        )
      },
    })
    const fileWatchTimes = new Map()
    let enabledTypeScript = usingTypeScript
    let previousClientRouterFilters: any
    let previousConflictingPagePaths: Set<string> = new Set()

    wp.on('aggregated', async () => {
      let middlewareMatchers: MiddlewareMatcher[] | undefined
      const routedPages: string[] = []
      const knownFiles = wp.getTimeInfoEntries()
      const pageNameSet = new Set<string>()
      const conflictingAppPagePaths = new Set<string>()
      const appPageFilePaths = new Map<string, string>()
      const pagesPageFilePaths = new Map<string, string>()

      let envChange = false
      let tsconfigChange = false
      let conflictingPageChange = 0
      let hasRootAppNotFound = false

      const { appPaths, appPages, appFiles, pageFiles } = opts.fsChecker

      appPaths.clear()
      appPages.clear()
      appFiles.clear()
      pageFiles.clear()
      devPageFiles.clear()

      const sortedKnownFiles: string[] = [...knownFiles.keys()].sort(
        sortByPageExts(nextConfig.pageExtensions)
      )

      for (const fileName of sortedKnownFiles) {
        if (
          !files.includes(fileName) &&
          !directories.some((d) => fileName.startsWith(d))
        ) {
          continue
        }
        const meta = knownFiles.get(fileName)

        const watchTime = fileWatchTimes.get(fileName)
        const watchTimeChange = watchTime && watchTime !== meta?.timestamp
        fileWatchTimes.set(fileName, meta.timestamp)

        if (envFiles.includes(fileName)) {
          if (watchTimeChange) {
            envChange = true
          }
          continue
        }

        if (tsconfigPaths.includes(fileName)) {
          if (fileName.endsWith('tsconfig.json')) {
            enabledTypeScript = true
          }
          if (watchTimeChange) {
            tsconfigChange = true
          }
          continue
        }

        if (
          meta?.accuracy === undefined ||
          !validFileMatcher.isPageFile(fileName)
        ) {
          continue
        }

        const isAppPath = Boolean(
          appDir &&
            normalizePathSep(fileName).startsWith(
              normalizePathSep(appDir) + '/'
            )
        )
        const isPagePath = Boolean(
          pagesDir &&
            normalizePathSep(fileName).startsWith(
              normalizePathSep(pagesDir) + '/'
            )
        )

        const rootFile = absolutePathToPage(fileName, {
          dir: dir,
          extensions: nextConfig.pageExtensions,
          keepIndex: false,
          pagesType: 'root',
        })

        if (isMiddlewareFile(rootFile)) {
          const staticInfo = await getStaticInfoIncludingLayouts({
            pageFilePath: fileName,
            config: nextConfig,
            appDir: appDir,
            page: rootFile,
            isDev: true,
            isInsideAppDir: isAppPath,
            pageExtensions: nextConfig.pageExtensions,
          })
          if (nextConfig.output === 'export') {
            Log.error(
              'Middleware cannot be used with "output: export". See more info here: https://nextjs.org/docs/advanced-features/static-html-export'
            )
            continue
          }
          serverFields.actualMiddlewareFile = rootFile
          await propagateToWorkers(
            'actualMiddlewareFile',
            serverFields.actualMiddlewareFile
          )
          middlewareMatchers = staticInfo.middleware?.matchers || [
            { regexp: '.*', originalSource: '/:path*' },
          ]
          continue
        }
        if (
          isInstrumentationHookFile(rootFile) &&
          nextConfig.experimental.instrumentationHook
        ) {
          NextBuildContext.hasInstrumentationHook = true
          serverFields.actualInstrumentationHookFile = rootFile
          await propagateToWorkers(
            'actualInstrumentationHookFile',
            serverFields.actualInstrumentationHookFile
          )
          continue
        }

        if (fileName.endsWith('.ts') || fileName.endsWith('.tsx')) {
          enabledTypeScript = true
        }

        if (!(isAppPath || isPagePath)) {
          continue
        }

        // Collect all current filenames for the TS plugin to use
        devPageFiles.add(fileName)

        let pageName = absolutePathToPage(fileName, {
          dir: isAppPath ? appDir! : pagesDir!,
          extensions: nextConfig.pageExtensions,
          keepIndex: isAppPath,
          pagesType: isAppPath ? 'app' : 'pages',
        })

        if (
          !isAppPath &&
          isAPIRoute(pageName) &&
          nextConfig.output === 'export'
        ) {
          Log.error(
            'API Routes cannot be used with "output: export". See more info here: https://nextjs.org/docs/advanced-features/static-html-export'
          )
          continue
        }

        if (isAppPath) {
          const isRootNotFound = validFileMatcher.isRootNotFound(fileName)
          hasRootAppNotFound = true

          if (isRootNotFound) {
            continue
          }
          if (!isRootNotFound && !validFileMatcher.isAppRouterPage(fileName)) {
            continue
          }
          // Ignore files/directories starting with `_` in the app directory
          if (normalizePathSep(pageName).includes('/_')) {
            continue
          }

          const originalPageName = pageName
          pageName = normalizeAppPath(pageName).replace(/%5F/g, '_')

          let appPagePaths = appPaths.get(pageName)
          if (!appPagePaths) {
            appPagePaths = []
            appPaths.set(pageName, appPagePaths)
          }
          appPagePaths.push(originalPageName)

          if (useFileSystemPublicRoutes) {
            appFiles.add(pageName)
            appPages.set(pageName, originalPageName)
          }

          if (routedPages.includes(pageName)) {
            continue
          }
        } else {
          if (useFileSystemPublicRoutes) {
            pageFiles.add(pageName)
            // always add to nextDataRoutes for now but in future only add
            // entries that actually use getStaticProps/getServerSideProps
            opts.fsChecker.nextDataRoutes.add(pageName)
          }
        }
        ;(isAppPath ? appPageFilePaths : pagesPageFilePaths).set(
          pageName,
          fileName
        )

        if (appDir && pageNameSet.has(pageName)) {
          conflictingAppPagePaths.add(pageName)
        } else {
          pageNameSet.add(pageName)
        }

        /**
         * If there is a middleware that is not declared in the root we will
         * warn without adding it so it doesn't make its way into the system.
         */
        if (/[\\\\/]_middleware$/.test(pageName)) {
          nestedMiddleware.push(pageName)
          continue
        }

        routedPages.push(pageName)
      }

      const numConflicting = conflictingAppPagePaths.size
      conflictingPageChange = numConflicting - previousConflictingPagePaths.size

      if (conflictingPageChange !== 0) {
        if (numConflicting > 0) {
          let errorMessage = `Conflicting app and page file${
            numConflicting === 1 ? ' was' : 's were'
          } found, please remove the conflicting files to continue:\n`

          for (const p of conflictingAppPagePaths) {
            const appPath = path.relative(dir, appPageFilePaths.get(p)!)
            const pagesPath = path.relative(dir, pagesPageFilePaths.get(p)!)
            errorMessage += `  "${pagesPath}" - "${appPath}"\n`
          }
          hotReloader.setHmrServerError(new Error(errorMessage))
        } else if (numConflicting === 0) {
          hotReloader.clearHmrServerError()
          await propagateToWorkers('reloadMatchers', undefined)
        }
      }

      previousConflictingPagePaths = conflictingAppPagePaths

      let clientRouterFilters: any
      if (nextConfig.experimental.clientRouterFilter) {
        clientRouterFilters = createClientRouterFilter(
          Object.keys(appPaths),
          nextConfig.experimental.clientRouterFilterRedirects
            ? ((nextConfig as any)._originalRedirects || []).filter(
                (r: any) => !r.internal
              )
            : [],
          nextConfig.experimental.clientRouterFilterAllowedRate
        )

        if (
          !previousClientRouterFilters ||
          JSON.stringify(previousClientRouterFilters) !==
            JSON.stringify(clientRouterFilters)
        ) {
          envChange = true
          previousClientRouterFilters = clientRouterFilters
        }
      }

      if (!usingTypeScript && enabledTypeScript) {
        // we tolerate the error here as this is best effort
        // and the manual install command will be shown
        await verifyTypeScript(opts)
          .then(() => {
            tsconfigChange = true
          })
          .catch(() => {})
      }

      if (envChange || tsconfigChange) {
        if (envChange) {
          loadEnvConfig(dir, true, Log, true)
          await propagateToWorkers('loadEnvConfig', [
            { dev: true, forceReload: true, silent: true },
          ])
        }
        let tsconfigResult:
          | UnwrapPromise<ReturnType<typeof loadJsConfig>>
          | undefined

        if (tsconfigChange) {
          try {
            tsconfigResult = await loadJsConfig(dir, nextConfig)
          } catch (_) {
            /* do we want to log if there are syntax errors in tsconfig  while editing? */
          }
        }

        hotReloader.activeWebpackConfigs?.forEach((config, idx) => {
          const isClient = idx === 0
          const isNodeServer = idx === 1
          const isEdgeServer = idx === 2
          const hasRewrites =
            opts.fsChecker.rewrites.afterFiles.length > 0 ||
            opts.fsChecker.rewrites.beforeFiles.length > 0 ||
            opts.fsChecker.rewrites.fallback.length > 0

          if (tsconfigChange) {
            config.resolve?.plugins?.forEach((plugin: any) => {
              // look for the JsConfigPathsPlugin and update with
              // the latest paths/baseUrl config
              if (plugin && plugin.jsConfigPlugin && tsconfigResult) {
                const { resolvedBaseUrl, jsConfig } = tsconfigResult
                const currentResolvedBaseUrl = plugin.resolvedBaseUrl
                const resolvedUrlIndex = config.resolve?.modules?.findIndex(
                  (item) => item === currentResolvedBaseUrl
                )

                if (
                  resolvedBaseUrl &&
                  resolvedBaseUrl !== currentResolvedBaseUrl
                ) {
                  // remove old baseUrl and add new one
                  if (resolvedUrlIndex && resolvedUrlIndex > -1) {
                    config.resolve?.modules?.splice(resolvedUrlIndex, 1)
                  }
                  config.resolve?.modules?.push(resolvedBaseUrl)
                }

                if (jsConfig?.compilerOptions?.paths && resolvedBaseUrl) {
                  Object.keys(plugin.paths).forEach((key) => {
                    delete plugin.paths[key]
                  })
                  Object.assign(plugin.paths, jsConfig.compilerOptions.paths)
                  plugin.resolvedBaseUrl = resolvedBaseUrl
                }
              }
            })
          }

          if (envChange) {
            config.plugins?.forEach((plugin: any) => {
              // we look for the DefinePlugin definitions so we can
              // update them on the active compilers
              if (
                plugin &&
                typeof plugin.definitions === 'object' &&
                plugin.definitions.__NEXT_DEFINE_ENV
              ) {
                const newDefine = getDefineEnv({
                  dev: true,
                  config: nextConfig,
                  distDir,
                  isClient,
                  hasRewrites,
                  isNodeServer,
                  isEdgeServer,
                  clientRouterFilters,
                })

                Object.keys(plugin.definitions).forEach((key) => {
                  if (!(key in newDefine)) {
                    delete plugin.definitions[key]
                  }
                })
                Object.assign(plugin.definitions, newDefine)
              }
            })
          }
        })
        hotReloader.invalidate({
          reloadAfterInvalidation: envChange,
        })
      }

      if (nestedMiddleware.length > 0) {
        Log.error(
          new NestedMiddlewareError(
            nestedMiddleware,
            dir,
            (pagesDir || appDir)!
          ).message
        )
        nestedMiddleware = []
      }

      // Make sure to sort parallel routes to make the result deterministic.
      serverFields.appPathRoutes = Object.fromEntries(
        Object.entries(appPaths).map(([k, v]) => [k, v.sort()])
      )
      await propagateToWorkers('appPathRoutes', serverFields.appPathRoutes)

      // TODO: pass this to fsChecker/next-dev-server?
      serverFields.middleware = middlewareMatchers
        ? {
            match: null as any,
            page: '/',
            matchers: middlewareMatchers,
          }
        : undefined

      await propagateToWorkers('middleware', serverFields.middleware)
      serverFields.hasAppNotFound = hasRootAppNotFound

      opts.fsChecker.middlewareMatcher = serverFields.middleware?.matchers
        ? getMiddlewareRouteMatcher(serverFields.middleware?.matchers)
        : undefined

      opts.fsChecker.interceptionRoutes =
        generateInterceptionRoutesRewrites(Object.keys(appPaths))?.map((item) =>
          buildCustomRoute(
            'before_files_rewrite',
            item,
            opts.nextConfig.basePath,
            opts.nextConfig.experimental.caseSensitiveRoutes
          )
        ) || []

      const exportPathMap =
        (typeof nextConfig.exportPathMap === 'function' &&
          (await nextConfig.exportPathMap?.(
            {},
            {
              dev: true,
              dir: opts.dir,
              outDir: null,
              distDir: distDir,
              buildId: 'development',
            }
          ))) ||
        {}

      for (const [key, value] of Object.entries(exportPathMap || {})) {
        opts.fsChecker.interceptionRoutes.push(
          buildCustomRoute(
            'before_files_rewrite',
            {
              source: key,
              destination: `${value.page}${
                value.query ? '?' : ''
              }${qs.stringify(value.query)}`,
            },
            opts.nextConfig.basePath,
            opts.nextConfig.experimental.caseSensitiveRoutes
          )
        )
      }

      try {
        // we serve a separate manifest with all pages for the client in
        // dev mode so that we can match a page after a rewrite on the client
        // before it has been built and is populated in the _buildManifest
        const sortedRoutes = getSortedRoutes(routedPages)

        opts.fsChecker.dynamicRoutes = sortedRoutes.map(
          (page): FilesystemDynamicRoute => {
            const regex = getRouteRegex(page)
            return {
              regex: regex.re.toString(),
              match: getRouteMatcher(regex),
              page,
              supportsLocales: opts.fsChecker.supportsLocales(page),
            }
          }
        )

        const dataRoutes: typeof opts.fsChecker.dynamicRoutes = []

        for (const page of sortedRoutes) {
          // Only add data routes for pages in the `pages/` directory. They are
          // the only ones that can have `getStaticProps`/`getServerSideProps`.
          if (!pagesPageFilePaths.has(page)) continue

          // Exclude any `/api` routes as they don't have associated data
          // routes either.
          if (!isAPIRoute(page)) continue

          const route = buildDataRoute(page, 'development')
          const routeRegex = getRouteRegex(route.page)
          dataRoutes.push({
            ...route,
            regex: routeRegex.re.toString(),
            match: getRouteMatcher({
              // TODO: fix this in the manifest itself, must also be fixed in
              // upstream builder that relies on this
              re: opts.nextConfig.i18n
                ? new RegExp(
                    route.dataRouteRegex.replace(
                      `/development/`,
                      `/development/(?<nextLocale>.+?)/`
                    )
                  )
                : new RegExp(route.dataRouteRegex),
              groups: routeRegex.groups,
            }),
            // All data routes are for pages anyways and are therefore always
            // should have their locale prefix stripped.
            supportsLocales: true,
          })
        }
        opts.fsChecker.dynamicRoutes.unshift(...dataRoutes)

        if (!prevSortedRoutes?.every((val, idx) => val === sortedRoutes[idx])) {
          const addedRoutes = sortedRoutes.filter(
            (route) => !prevSortedRoutes.includes(route)
          )
          const removedRoutes = prevSortedRoutes.filter(
            (route) => !sortedRoutes.includes(route)
          )

          // emit the change so clients fetch the update
          hotReloader.send('devPagesManifestUpdate', {
            devPagesManifest: true,
          })

          addedRoutes.forEach((route) => {
            hotReloader.send('addedPage', route)
          })

          removedRoutes.forEach((route) => {
            hotReloader.send('removedPage', route)
          })
        }
        prevSortedRoutes = sortedRoutes

        if (!resolved) {
          resolve()
          resolved = true
        }
      } catch (e) {
        if (!resolved) {
          reject(e)
          resolved = true
        } else {
          Log.warn('Failed to reload dynamic routes:', e)
        }
      } finally {
        // Reload the matchers. The filesystem would have been written to,
        // and the matchers need to re-scan it to update the router.
        await propagateToWorkers('reloadMatchers', undefined)
      }
    })

    wp.watch({ directories: [dir], startTime: 0 })
  })

  const clientPagesManifestPath = `/_next/${CLIENT_STATIC_FILES_PATH}/development/${DEV_CLIENT_PAGES_MANIFEST}`
  opts.fsChecker.devVirtualFsItems.add(clientPagesManifestPath)

  const devMiddlewareManifestPath = `/_next/${CLIENT_STATIC_FILES_PATH}/development/${DEV_MIDDLEWARE_MANIFEST}`
  opts.fsChecker.devVirtualFsItems.add(devMiddlewareManifestPath)

  async function requestHandler(req: IncomingMessage, res: ServerResponse) {
    const parsedUrl = url.parse(req.url || '/')

    if (parsedUrl.pathname === clientPagesManifestPath) {
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(
        JSON.stringify({
          pages: prevSortedRoutes.filter(
            (route) => !opts.fsChecker.appFiles.has(route)
          ),
        })
      )
      return { finished: true }
    }

    if (parsedUrl.pathname === devMiddlewareManifestPath) {
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(serverFields.middleware?.matchers || []))
      return { finished: true }
    }
    return { finished: false }
  }

  async function logErrorWithOriginalStack(
    err: unknown,
    type?: 'unhandledRejection' | 'uncaughtException' | 'warning' | 'app-dir'
  ) {
    let usedOriginalStack = false

    if (isError(err) && err.stack) {
      try {
        const frames = parseStack(err.stack!)
        // Filter out internal edge related runtime stack
        const frame = frames.find(
          ({ file }) =>
            !file?.startsWith('eval') &&
            !file?.includes('web/adapter') &&
            !file?.includes('web/globals') &&
            !file?.includes('sandbox/context') &&
            !file?.includes('<anonymous>')
        )

        if (frame?.lineNumber && frame?.file) {
          const moduleId = frame.file!.replace(
            /^(webpack-internal:\/\/\/|file:\/\/)/,
            ''
          )
          const modulePath = frame.file.replace(
            /^(webpack-internal:\/\/\/|file:\/\/)(\(.*\)\/)?/,
            ''
          )

          const src = getErrorSource(err as Error)
          const isEdgeCompiler = src === COMPILER_NAMES.edgeServer
          const compilation = (
            isEdgeCompiler
              ? hotReloader.edgeServerStats?.compilation
              : hotReloader.serverStats?.compilation
          )!

          const source = await getSourceById(
            !!frame.file?.startsWith(path.sep) ||
              !!frame.file?.startsWith('file:'),
            moduleId,
            compilation
          )

          const originalFrame = await createOriginalStackFrame({
            line: frame.lineNumber,
            column: frame.column,
            source,
            frame,
            moduleId,
            modulePath,
            rootDirectory: opts.dir,
            errorMessage: err.message,
            serverCompilation: isEdgeCompiler
              ? undefined
              : hotReloader.serverStats?.compilation,
            edgeCompilation: isEdgeCompiler
              ? hotReloader.edgeServerStats?.compilation
              : undefined,
          }).catch(() => {})

          if (originalFrame) {
            const { originalCodeFrame, originalStackFrame } = originalFrame
            const { file, lineNumber, column, methodName } = originalStackFrame

            Log[type === 'warning' ? 'warn' : 'error'](
              `${file} (${lineNumber}:${column}) @ ${methodName}`
            )
            if (isEdgeCompiler) {
              err = err.message
            }
            if (type === 'warning') {
              Log.warn(err)
            } else if (type === 'app-dir') {
              logAppDirError(err)
            } else if (type) {
              Log.error(`${type}:`, err)
            } else {
              Log.error(err)
            }
            console[type === 'warning' ? 'warn' : 'error'](originalCodeFrame)
            usedOriginalStack = true
          }
        }
      } catch (_) {
        // failed to load original stack using source maps
        // this un-actionable by users so we don't show the
        // internal error and only show the provided stack
      }
    }

    if (!usedOriginalStack) {
      if (type === 'warning') {
        Log.warn(err)
      } else if (type === 'app-dir') {
        logAppDirError(err)
      } else if (type) {
        Log.error(`${type}:`, err)
      } else {
        Log.error(err)
      }
    }
  }

  return {
    serverFields,
    hotReloader,
    requestHandler,
    logErrorWithOriginalStack,

    async ensureMiddleware() {
      if (!serverFields.actualMiddlewareFile) return
      return hotReloader.ensurePage({
        page: serverFields.actualMiddlewareFile,
        clientOnly: false,
      })
    },
  }
}

export async function setupDev(opts: SetupOpts) {
  const isSrcDir = path
    .relative(opts.dir, opts.pagesDir || opts.appDir || '')
    .startsWith('src')

  const result = await startWatcher(opts)

  opts.telemetry.record(
    eventCliSession(
      path.join(opts.dir, opts.nextConfig.distDir),
      opts.nextConfig,
      {
        webpackVersion: 5,
        isSrcDir,
        turboFlag: false,
        cliCommand: 'dev',
        appDir: !!opts.appDir,
        pagesDir: !!opts.pagesDir,
        isCustomServer: !!opts.isCustomServer,
        hasNowJson: !!(await findUp('now.json', { cwd: opts.dir })),
      }
    )
  )
  return result
}
