import {
  buildClientSchema,
  getIntrospectionQuery,
  IntrospectionQuery,
  GraphQLSchema,
} from "graphql"
import { CacheManager } from "../cache/cacheManager"

const SCHEMA_CACHE_KEY = "schema"

export async function fetchIntrospection(
  endpoint: string
): Promise<IntrospectionQuery> {
  const query = getIntrospectionQuery()

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`Introspection failed: HTTP ${response.status}`)
    }

    const json = (await response.json()) as {
      data?: IntrospectionQuery
      errors?: Array<{ message: string }>
    }
    if (json.errors && json.errors.length > 0) {
      throw new Error(
        `Introspection errors: ${json.errors.map(e => e.message).join(", ")}`
      )
    }
    if (!json.data) {
      throw new Error("Introspection returned no data")
    }

    return json.data
  } finally {
    clearTimeout(timeout)
  }
}

export function buildSchemaFromIntrospection(
  introspection: IntrospectionQuery
): GraphQLSchema {
  return buildClientSchema(introspection)
}

export async function fetchAndCacheSchema(
  endpoint: string,
  cache: CacheManager
): Promise<GraphQLSchema> {
  const introspection = await fetchIntrospection(endpoint)
  await cache.writeDisk(SCHEMA_CACHE_KEY, introspection)
  const schema = buildSchemaFromIntrospection(introspection)
  return schema
}

export async function loadCachedSchema(
  cache: CacheManager
): Promise<GraphQLSchema | null> {
  const entry = await cache.readDisk<IntrospectionQuery>(SCHEMA_CACHE_KEY)
  if (!entry) {
    return null
  }
  try {
    return buildSchemaFromIntrospection(entry.data)
  } catch {
    return null
  }
}

export async function getCacheTimestamp(
  cache: CacheManager
): Promise<number | null> {
  const entry = await cache.readDisk<IntrospectionQuery>(SCHEMA_CACHE_KEY)
  return entry ? entry.timestamp : null
}
