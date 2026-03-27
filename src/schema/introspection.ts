import { GraphQLSchema } from "graphql"
import { CacheManager } from "../cache/cacheManager"
import {
  buildSchemaFromDirectory,
  SchemaBuildResult,
} from "./rubySchemaBuilder"

const SCHEMA_CACHE_KEY = "schema-build-result"

/**
 * Build schema directly from Ruby files on disk.
 */
export function buildSchemaFromFiles(basePath: string): SchemaBuildResult {
  return buildSchemaFromDirectory(basePath)
}

/**
 * Cache a successful schema build result (type defs metadata) to disk.
 */
export async function cacheSchemaResult(
  cache: CacheManager,
  result: SchemaBuildResult
): Promise<void> {
  // Cache metadata (not the schema object itself)
  await cache.writeDisk(SCHEMA_CACHE_KEY, {
    typeCount: result.typeCount,
    errors: result.errors,
    skippedFiles: result.skippedFiles,
    timestamp: Date.now(),
  })
}

/**
 * Get the timestamp of the last cached schema build.
 */
export async function getCacheTimestamp(
  cache: CacheManager
): Promise<number | null> {
  const entry = await cache.readDisk<{ timestamp: number }>(SCHEMA_CACHE_KEY)
  return entry ? entry.data.timestamp : null
}
