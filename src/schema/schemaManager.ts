import { GraphQLSchema } from "graphql"
import * as logger from "../outputChannel"
import { CacheManager } from "../cache/cacheManager"
import {
  LocalSchemaServer,
  LocalSchemaServerOptions,
} from "./localSchemaServer"
import { cacheSchemaResult, getCacheTimestamp } from "./introspection"

export type SchemaStatus = "unloaded" | "loading" | "ready" | "error" | "cached"

export interface SchemaStatusInfo {
  status: SchemaStatus
  message: string
  timestamp?: number
}

export class SchemaManager {
  private schema: GraphQLSchema | null = null
  private cache: CacheManager
  private basePath: string
  private localServer: LocalSchemaServer | null = null
  private status: SchemaStatus = "unloaded"
  private statusMessage = ""
  private onStatusChange?: (info: SchemaStatusInfo) => void
  private onSchemaReady?: (schema: GraphQLSchema) => void

  constructor(
    basePath: string,
    cache: CacheManager,
    callbacks?: {
      onStatusChange?: (info: SchemaStatusInfo) => void
      onSchemaReady?: (schema: GraphQLSchema) => void
    }
  ) {
    this.basePath = basePath
    this.cache = cache
    this.onStatusChange = callbacks?.onStatusChange
    this.onSchemaReady = callbacks?.onSchemaReady
  }

  getSchema(): GraphQLSchema | null {
    return this.schema
  }

  getStatus(): SchemaStatusInfo {
    return {
      status: this.status,
      message: this.statusMessage,
    }
  }

  private setStatus(
    status: SchemaStatus,
    message: string,
    timestamp?: number
  ): void {
    this.status = status
    this.statusMessage = message
    this.onStatusChange?.({ status, message, timestamp })
  }

  async initialize(): Promise<void> {
    this.setStatus("loading", "Building GraphQL schema from Ruby files...")

    try {
      this.localServer = new LocalSchemaServer({
        basePath: this.basePath,
        onSchemaRebuilt: result => {
          this.schema = result.schema
          cacheSchemaResult(this.cache, result).catch(() => {})

          const msg =
            result.errors.length > 0
              ? `Schema ready (${result.typeCount} types, ${result.errors.length} warnings)`
              : `Schema ready (${result.typeCount} types)`

          this.setStatus("ready", msg)
          this.onSchemaReady?.(result.schema)
        },
        onError: error => {
          // Only set error status if we have no schema at all
          if (!this.schema) {
            this.setStatus("error", `Schema build failed: ${error.message}`)
          } else {
            // Keep using existing schema
            logger.warn(
              `[NitroGraphQL] Schema rebuild failed, keeping previous schema: ${error.message}`
            )
          }
        },
      })

      await this.localServer.start()

      const schema = this.localServer.getSchema()
      if (schema) {
        this.schema = schema
        const result = this.localServer.getLastBuildResult()
        const typeCount = result?.typeCount ?? 0
        this.setStatus("ready", `Schema ready (${typeCount} types)`)
        this.onSchemaReady?.(schema)
      } else {
        this.setStatus(
          "error",
          "No schema available. Check that Ruby GraphQL files exist."
        )
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.error(`[NitroGraphQL] Failed to start schema server: ${msg}`)
      this.setStatus("error", `Schema build failed: ${msg}`)
    }
  }

  async refresh(): Promise<void> {
    this.setStatus("loading", "Rebuilding GraphQL schema...")

    if (this.localServer) {
      const success = await this.localServer.rebuildSchema()
      if (!success && !this.schema) {
        this.setStatus("error", "Schema rebuild failed")
      }
    } else {
      this.setStatus("error", "Schema server not running")
    }
  }

  dispose(): void {
    this.localServer?.stop().catch(() => {})
    this.localServer = null
    this.schema = null
  }
}
