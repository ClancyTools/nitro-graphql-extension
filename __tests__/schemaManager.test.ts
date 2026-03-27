import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { buildSchema, GraphQLSchema } from "graphql"
import { SchemaManager } from "../src/schema/schemaManager"
import { CacheManager } from "../src/cache/cacheManager"

// ── Fixtures for local schema building ──

const QUERY_TYPE_FIXTURE = `
module NitroGraphql
  class QueryType < NitroGraphql::Types::BaseObject
    graphql_name "Queries"
    field :user, ::Directory::Graphql::EmployeeType, null: true
  end
end
`

const EMPLOYEE_TYPE_FIXTURE = `
module Directory
  module Graphql
    class EmployeeType < NitroGraphql::Types::BaseObject
      graphql_name "Employee"
      field :id, ID, null: false
      field :name, String, null: false
    end
  end
end
`

function createTestFixtures(tmpDir: string): void {
  const gqlDir = path.join(tmpDir, "components", "test", "app", "graphql")
  fs.mkdirSync(gqlDir, { recursive: true })
  fs.writeFileSync(path.join(gqlDir, "query_type.rb"), QUERY_TYPE_FIXTURE)
  fs.writeFileSync(path.join(gqlDir, "employee_type.rb"), EMPLOYEE_TYPE_FIXTURE)
}

describe("SchemaManager", () => {
  let cache: CacheManager
  let tmpDir: string

  beforeEach(() => {
    cache = new CacheManager(10)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nitro-sm-test-"))
  })

  afterEach(async () => {
    await cache.clearAll()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("should start with unloaded status", () => {
    const manager = new SchemaManager(tmpDir, cache)
    const status = manager.getStatus()
    expect(status.status).toBe("unloaded")
    manager.dispose()
  })

  it("should have null schema before initialization", () => {
    const manager = new SchemaManager(tmpDir, cache)
    expect(manager.getSchema()).toBeNull()
    manager.dispose()
  })

  it("should report error when no graphql files found", async () => {
    const statusChanges: string[] = []
    const manager = new SchemaManager(tmpDir, cache, {
      onStatusChange: info => statusChanges.push(info.status),
    })

    await manager.initialize()

    expect(statusChanges).toContain("error")
    manager.dispose()
  })

  it("should build schema from local Ruby files", async () => {
    createTestFixtures(tmpDir)

    const statusChanges: string[] = []
    const manager = new SchemaManager(tmpDir, cache, {
      onStatusChange: info => statusChanges.push(info.status),
    })

    await manager.initialize()

    expect(manager.getSchema()).not.toBeNull()
    expect(statusChanges).toContain("ready")
    manager.dispose()
  })

  it("should call onSchemaReady when schema is built", async () => {
    createTestFixtures(tmpDir)

    let schemaReady = false
    const manager = new SchemaManager(tmpDir, cache, {
      onSchemaReady: () => {
        schemaReady = true
      },
    })

    await manager.initialize()

    expect(schemaReady).toBe(true)
    manager.dispose()
  })

  it("should refresh schema on demand", async () => {
    createTestFixtures(tmpDir)

    const manager = new SchemaManager(tmpDir, cache)
    await manager.initialize()

    const schemaBefore = manager.getSchema()
    expect(schemaBefore).not.toBeNull()

    await manager.refresh()
    expect(manager.getSchema()).not.toBeNull()
    manager.dispose()
  })

  it("should clean up on dispose", async () => {
    createTestFixtures(tmpDir)

    const manager = new SchemaManager(tmpDir, cache)
    await manager.initialize()

    manager.dispose()
    expect(manager.getSchema()).toBeNull()
  })
})
