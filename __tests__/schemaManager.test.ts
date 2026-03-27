import {
  buildSchema,
  GraphQLSchema,
  IntrospectionQuery,
  introspectionFromSchema,
} from "graphql"
import { buildSchemaFromIntrospection } from "../src/schema/introspection"
import { SchemaManager } from "../src/schema/schemaManager"
import { CacheManager } from "../src/cache/cacheManager"

// Build a test schema and get its introspection result
const TEST_SDL = `
  type Query {
    user(id: ID!): User
    project(id: ID!): Project
  }
  type User {
    id: ID!
    name: String
    email: String
  }
  type Project {
    id: ID!
    name: String
  }
`

describe("Schema Introspection", () => {
  let testSchema: GraphQLSchema
  let introspectionResult: IntrospectionQuery

  beforeAll(() => {
    testSchema = buildSchema(TEST_SDL)
    introspectionResult = introspectionFromSchema(testSchema)
  })

  it("should build a schema from introspection result", () => {
    const schema = buildSchemaFromIntrospection(introspectionResult)
    expect(schema).toBeDefined()
    const queryType = schema.getQueryType()
    expect(queryType).toBeDefined()
    expect(queryType!.name).toBe("Query")
  })

  it("should preserve query fields in built schema", () => {
    const schema = buildSchemaFromIntrospection(introspectionResult)
    const queryType = schema.getQueryType()!
    const fields = queryType.getFields()
    expect(fields["user"]).toBeDefined()
    expect(fields["project"]).toBeDefined()
  })

  it("should preserve type fields in built schema", () => {
    const schema = buildSchemaFromIntrospection(introspectionResult)
    const userType = schema.getType("User")
    expect(userType).toBeDefined()
  })
})

describe("SchemaManager", () => {
  let cache: CacheManager

  beforeEach(() => {
    cache = new CacheManager(10)
  })

  afterEach(async () => {
    await cache.clearAll()
  })

  it("should start with unloaded status", () => {
    const manager = new SchemaManager("http://localhost:3000/graphql", cache, 0)
    const status = manager.getStatus()
    expect(status.status).toBe("unloaded")
    manager.dispose()
  })

  it("should have null schema before initialization", () => {
    const manager = new SchemaManager("http://localhost:3000/graphql", cache, 0)
    expect(manager.getSchema()).toBeNull()
    manager.dispose()
  })

  it("should fall back to cached schema when endpoint is unavailable", async () => {
    // Pre-populate cache with a valid introspection result
    const testSchema = buildSchema(TEST_SDL)
    const introspection = introspectionFromSchema(testSchema)
    await cache.writeDisk("schema", introspection)

    const statusChanges: string[] = []
    const manager = new SchemaManager(
      "http://localhost:99999/graphql",
      cache,
      0,
      {
        onStatusChange: info => statusChanges.push(info.status),
      }
    )

    await manager.initialize()

    // Should have fallen back to cached schema
    expect(manager.getSchema()).not.toBeNull()
    expect(statusChanges).toContain("cached")
    manager.dispose()
  })

  it("should report error when no cache and endpoint unavailable", async () => {
    const statusChanges: string[] = []
    const manager = new SchemaManager(
      "http://localhost:99999/graphql",
      cache,
      0,
      {
        onStatusChange: info => statusChanges.push(info.status),
      }
    )

    await manager.initialize()

    expect(manager.getSchema()).toBeNull()
    expect(statusChanges).toContain("error")
    manager.dispose()
  })

  it("should update endpoint", () => {
    const manager = new SchemaManager("http://localhost:3000/graphql", cache, 0)
    manager.updateEndpoint("http://localhost:4000/graphql")
    // Just verifying no throw
    manager.dispose()
  })

  it("should clean up on dispose", () => {
    const manager = new SchemaManager(
      "http://localhost:3000/graphql",
      cache,
      30000
    )
    manager.dispose()
    expect(manager.getSchema()).toBeNull()
  })
})
