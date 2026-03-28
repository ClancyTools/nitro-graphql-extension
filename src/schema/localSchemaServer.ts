import * as http from "http"
import * as fs from "fs"
import * as path from "path"
import * as logger from "../outputChannel"
import { GraphQLSchema, graphql, getIntrospectionQuery } from "graphql"
import {
  buildSchemaFromDirectory,
  SchemaBuildResult,
} from "./rubySchemaBuilder"

export interface LocalSchemaServerOptions {
  basePath: string
  port?: number
  onSchemaRebuilt?: (result: SchemaBuildResult) => void
  onError?: (error: Error) => void
}

export class LocalSchemaServer {
  private server: http.Server | null = null
  private schema: GraphQLSchema | null = null
  private basePath: string
  private port: number
  private fsWatchers: fs.FSWatcher[] = []
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null
  private rebuildDebounceMs = 500
  private onSchemaRebuilt?: (result: SchemaBuildResult) => void
  private onError?: (error: Error) => void
  private lastBuildResult: SchemaBuildResult | null = null

  constructor(options: LocalSchemaServerOptions) {
    this.basePath = options.basePath
    this.port = options.port ?? 9876
    this.onSchemaRebuilt = options.onSchemaRebuilt
    this.onError = options.onError
  }

  getSchema(): GraphQLSchema | null {
    return this.schema
  }

  getLastBuildResult(): SchemaBuildResult | null {
    return this.lastBuildResult
  }

  getPort(): number {
    return this.port
  }

  /**
   * Start the local schema server:
   * 1. Build schema from Ruby files
   * 2. Start HTTP server
   * 3. Start file watchers
   */
  async start(): Promise<void> {
    // Build the initial schema
    const success = await this.rebuildSchema()

    if (!success) {
      logger.warn(
        "[NitroGraphQL] Initial schema build failed, server starting without schema"
      )
    }

    // Start HTTP server
    await this.startServer()

    // Start file watchers
    this.startFileWatchers()

    logger.log(
      `[NitroGraphQL] Local schema server running on port ${this.port}`
    )
  }

  /**
   * Stop the server, watchers, and clean up.
   */
  async stop(): Promise<void> {
    this.stopFileWatchers()

    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer)
      this.rebuildTimer = null
    }

    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close(err => {
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        })
      })
      this.server = null
    }

    logger.log("[NitroGraphQL] Local schema server stopped")
  }

  /**
   * Rebuild the schema from disk. Returns true on success.
   * On failure, keeps the previous valid schema.
   */
  async rebuildSchema(): Promise<boolean> {
    try {
      const result = buildSchemaFromDirectory(this.basePath)

      // Only update if the new schema is usable
      this.schema = result.schema
      this.lastBuildResult = result
      this.onSchemaRebuilt?.(result)

      logger.log(
        `[NitroGraphQL] Schema rebuilt: ${result.typeCount} types, ${result.resolverCount} resolvers, ${result.registrationCount} registrations, ${result.errors.length} warnings`
      )
      const queryType = result.schema.getQueryType()
      if (queryType) {
        const fields = Object.keys(queryType.getFields())
        logger.log(
          `[NitroGraphQL] Query fields (${fields.length}): ${fields.slice(0, 30).join(", ")}${fields.length > 30 ? "..." : ""}`
        )
      }
      const mutationType = result.schema.getMutationType()
      if (mutationType) {
        const fields = Object.keys(mutationType.getFields())
        logger.log(
          `[NitroGraphQL] Mutation fields (${fields.length}): ${fields.slice(0, 30).join(", ")}${fields.length > 30 ? "..." : ""}`
        )
      }
      return true
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))

      logger.error(`[NitroGraphQL] Schema rebuild failed: ${err.message}`)
      this.onError?.(err)

      // Keep existing schema if available
      return false
    }
  }

  private async startServer(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res)
      })

      this.server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          logger.warn(
            `[NitroGraphQL] Port ${this.port} in use, trying ${this.port + 1}`
          )
          this.port++
          this.server!.listen(this.port, "127.0.0.1", () => resolve())
        } else {
          reject(err)
        }
      })

      this.server.listen(this.port, "127.0.0.1", () => resolve())
    })
  }

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    // Only accept POST /graphql
    if (req.method !== "POST" || req.url !== "/graphql") {
      res.writeHead(404, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "Not found" }))
      return
    }

    let body = ""
    req.on("data", chunk => {
      body += chunk
      // Cap body size at 1MB
      if (body.length > 1_000_000) {
        res.writeHead(413, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "Request too large" }))
        req.destroy()
      }
    })

    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body) as {
          query?: string
          operationName?: string
          variables?: Record<string, unknown>
        }

        if (!parsed.query) {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Missing query" }))
          return
        }

        if (!this.schema) {
          res.writeHead(503, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Schema not available" }))
          return
        }

        const result = await graphql({
          schema: this.schema,
          source: parsed.query,
          operationName: parsed.operationName,
        })

        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(result))
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : "Invalid request",
          })
        )
      }
    })
  }

  private startFileWatchers(): void {
    this.stopFileWatchers()

    // Watch for .rb file changes in the base path's graphql directories
    const watchPattern = path.join(this.basePath, "components")

    try {
      const watcher = fs.watch(
        watchPattern,
        { recursive: true },
        (eventType, filename) => {
          if (
            filename &&
            filename.endsWith(".rb") &&
            filename.includes("graphql")
          ) {
            this.debouncedRebuild()
          }
        }
      )
      this.fsWatchers.push(watcher)
    } catch {
      logger.warn(
        `[NitroGraphQL] Could not watch ${watchPattern}, file watching disabled`
      )
    }
  }

  private stopFileWatchers(): void {
    for (const watcher of this.fsWatchers) {
      watcher.close()
    }
    this.fsWatchers = []
  }

  private debouncedRebuild(): void {
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer)
    }
    this.rebuildTimer = setTimeout(async () => {
      this.rebuildTimer = null
      logger.log(
        "[NitroGraphQL] Ruby GraphQL file changed, rebuilding schema..."
      )
      await this.rebuildSchema()
    }, this.rebuildDebounceMs)
  }
}
