import { GraphQLSchema } from "graphql"
import { CacheManager } from "../cache/cacheManager"
import {
  fetchAndCacheSchema,
  loadCachedSchema,
  getCacheTimestamp,
} from "./introspection"

export type SchemaStatus = "unloaded" | "loading" | "ready" | "error" | "cached"

export interface SchemaStatusInfo {
  status: SchemaStatus
  message: string
  timestamp?: number
}

export class SchemaManager {
  private schema: GraphQLSchema | null = null
  private cache: CacheManager
  private endpoint: string
  private pollingInterval: number
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private status: SchemaStatus = "unloaded"
  private statusMessage = ""
  private onStatusChange?: (info: SchemaStatusInfo) => void
  private onSchemaReady?: (schema: GraphQLSchema) => void

  constructor(
    endpoint: string,
    cache: CacheManager,
    pollingInterval: number,
    callbacks?: {
      onStatusChange?: (info: SchemaStatusInfo) => void
      onSchemaReady?: (schema: GraphQLSchema) => void
    }
  ) {
    this.endpoint = endpoint
    this.cache = cache
    this.pollingInterval = pollingInterval
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
    this.setStatus("loading", "Loading GraphQL schema...")

    try {
      this.schema = await fetchAndCacheSchema(this.endpoint, this.cache)
      this.setStatus("ready", "GraphQL schema ready")
      this.onSchemaReady?.(this.schema)
    } catch (fetchError) {
      console.warn(
        "[NitroGraphQL] Failed to fetch schema from endpoint, trying cache...",
        fetchError
      )

      const cached = await loadCachedSchema(this.cache)
      if (cached) {
        this.schema = cached
        const ts = await getCacheTimestamp(this.cache)
        const timeStr = ts ? new Date(ts).toLocaleString() : "unknown"
        this.setStatus("cached", `Using cached schema from ${timeStr}`)
        this.onSchemaReady?.(this.schema)
      } else {
        this.setStatus(
          "error",
          "No schema available. Start Rails server and refresh."
        )
      }
    }

    this.startPolling()
  }

  async refresh(): Promise<void> {
    this.setStatus("loading", "Refreshing GraphQL schema...")
    try {
      this.schema = await fetchAndCacheSchema(this.endpoint, this.cache)
      this.setStatus("ready", "GraphQL schema refreshed")
      this.onSchemaReady?.(this.schema)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this.setStatus("error", `Schema refresh failed: ${msg}`)
    }
  }

  private startPolling(): void {
    this.stopPolling()
    if (this.pollingInterval <= 0) {
      return
    }

    this.pollTimer = setInterval(async () => {
      try {
        const newSchema = await fetchAndCacheSchema(this.endpoint, this.cache)
        this.schema = newSchema
        if (this.status !== "ready") {
          this.setStatus("ready", "GraphQL schema ready")
        }
        this.onSchemaReady?.(newSchema)
      } catch {
        // Polling failures are silent — keep using current schema
      }
    }, this.pollingInterval)
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  updateEndpoint(endpoint: string): void {
    this.endpoint = endpoint
  }

  updatePollingInterval(interval: number): void {
    this.pollingInterval = interval
    if (this.status !== "unloaded") {
      this.startPolling()
    }
  }

  dispose(): void {
    this.stopPolling()
    this.schema = null
  }
}
