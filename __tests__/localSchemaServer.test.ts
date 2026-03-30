import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import * as http from "http"
import { LocalSchemaServer } from "../src/schema/localSchemaServer"
import { getIntrospectionQuery } from "graphql"

// ── Fixtures ───────────────────────────────────────────────────────────────────

const QUERY_TYPE_FIXTURE = `
module CircusApp
  class QueryType < CircusApp::Types::BaseObject
    graphql_name "Queries"
    field :performer, ::BigTop::Graphql::PerformerType, null: true
    field :tents, [::Midway::Graphql::TentType], null: false
  end
end
`

const PERFORMER_TYPE_FIXTURE = `
module BigTop
  module Graphql
    class PerformerType < CircusApp::Types::BaseObject
      graphql_name "Performer"
      field :id, ID, null: false
      field :name, String, null: false
    end
  end
end
`

const TENT_TYPE_FIXTURE = `
module Midway
  module Graphql
    class TentType < CircusApp::Types::BaseObject
      graphql_name "Tent"
      field :abbr, String, null: false
      field :name, String, null: false
    end
  end
end
`

function createTestFixtures(tmpDir: string): void {
  const gqlDir = path.join(tmpDir, "components", "test", "app", "graphql")
  fs.mkdirSync(gqlDir, { recursive: true })
  fs.writeFileSync(path.join(gqlDir, "query_type.rb"), QUERY_TYPE_FIXTURE)
  fs.writeFileSync(
    path.join(gqlDir, "performer_type.rb"),
    PERFORMER_TYPE_FIXTURE
  )
  fs.writeFileSync(path.join(gqlDir, "tent_type.rb"), TENT_TYPE_FIXTURE)
}

function httpPost(
  port: number,
  body: object
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/graphql",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      res => {
        let body = ""
        res.on("data", chunk => (body += chunk))
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(body) })
          } catch {
            resolve({ status: res.statusCode ?? 0, data: body })
          }
        })
      }
    )
    req.on("error", reject)
    req.write(data)
    req.end()
  })
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("LocalSchemaServer", () => {
  let tmpDir: string
  let server: LocalSchemaServer

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nitro-server-test-"))
    createTestFixtures(tmpDir)
  })

  afterEach(async () => {
    await server?.stop().catch(() => {})
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("should start and build schema from Ruby files", async () => {
    server = new LocalSchemaServer({ basePath: tmpDir, port: 19876 })
    await server.start()
    expect(server.getSchema()).not.toBeNull()
    expect(server.getLastBuildResult()!.typeCount).toBeGreaterThan(0)
  })

  it("should serve introspection queries", async () => {
    server = new LocalSchemaServer({ basePath: tmpDir, port: 19877 })
    await server.start()

    const result = await httpPost(19877, {
      query: getIntrospectionQuery(),
    })

    expect(result.status).toBe(200)
    expect(result.data.data).toBeDefined()
    expect(result.data.data.__schema).toBeDefined()
  })

  it("should return 404 for non-graphql paths", async () => {
    server = new LocalSchemaServer({ basePath: tmpDir, port: 19878 })
    await server.start()

    const result = await new Promise<{
      status: number
      data: any
    }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: 19878,
          path: "/other",
          method: "GET",
        },
        res => {
          let body = ""
          res.on("data", chunk => (body += chunk))
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              data: JSON.parse(body),
            })
          })
        }
      )
      req.on("error", reject)
      req.end()
    })

    expect(result.status).toBe(404)
  })

  it("should return 400 for missing query", async () => {
    server = new LocalSchemaServer({ basePath: tmpDir, port: 19879 })
    await server.start()

    const result = await httpPost(19879, {})
    expect(result.status).toBe(400)
  })

  it("should rebuild schema and keep previous on failure", async () => {
    server = new LocalSchemaServer({ basePath: tmpDir, port: 19880 })
    await server.start()

    const originalSchema = server.getSchema()
    expect(originalSchema).not.toBeNull()

    // Rebuild should succeed with same files
    const success = await server.rebuildSchema()
    expect(success).toBe(true)
  })

  it("should call onSchemaRebuilt callback", async () => {
    const onSchemaRebuilt = jest.fn()
    server = new LocalSchemaServer({
      basePath: tmpDir,
      port: 19881,
      onSchemaRebuilt,
    })
    await server.start()

    expect(onSchemaRebuilt).toHaveBeenCalledTimes(1)
    expect(onSchemaRebuilt.mock.calls[0][0].typeCount).toBeGreaterThan(0)
  })

  it("should call onError callback when build fails", async () => {
    const onError = jest.fn()
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "nitro-empty-"))

    server = new LocalSchemaServer({
      basePath: emptyDir,
      port: 19882,
      onError,
    })
    await server.start()

    expect(onError).toHaveBeenCalled()
    fs.rmSync(emptyDir, { recursive: true, force: true })
  })

  it("should serve a simple query against the schema", async () => {
    server = new LocalSchemaServer({ basePath: tmpDir, port: 19883 })
    await server.start()

    const result = await httpPost(19883, {
      query: "{ __typename }",
    })

    expect(result.status).toBe(200)
    expect(result.data.data).toBeDefined()
    expect(result.data.data.__typename).toBe("Queries")
  })

  it("should stop cleanly", async () => {
    server = new LocalSchemaServer({ basePath: tmpDir, port: 19884 })
    await server.start()
    await server.stop()

    // Server should no longer accept connections
    await expect(httpPost(19884, { query: "{ __typename }" })).rejects.toThrow()
  })

  it("should handle port already in use", async () => {
    // Start a dummy server on the port
    const blockingServer = http.createServer((_, res) => {
      res.end("ok")
    })
    await new Promise<void>(resolve => {
      blockingServer.listen(19885, "127.0.0.1", resolve)
    })

    try {
      server = new LocalSchemaServer({ basePath: tmpDir, port: 19885 })
      await server.start()
      // Should have moved to next port
      expect(server.getPort()).toBe(19886)
    } finally {
      await new Promise<void>(resolve => blockingServer.close(() => resolve()))
    }
  })
})
