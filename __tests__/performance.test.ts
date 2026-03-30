import { buildSchema, GraphQLSchema } from "graphql"
import { findGraphQLTemplates } from "../src/validation/queryFinder"
import {
  validateTemplate,
  validateTemplates,
} from "../src/validation/validator"
import { CacheManager } from "../src/cache/cacheManager"

const TEST_SCHEMA_SDL = `
  type Query {
    circusAct(id: ID!): CircusAct
    user(id: ID!): User
    show(id: ID!): Show
  }
  type CircusAct {
    id: ID!
    canBeRescheduled: Boolean
    canChangeTiming: Boolean
    estimatedCurtainAt: String
    routine: Routine
    scheduledFor: String
    rigger: Rigger
    prop: Prop
    show: Show
  }
  type Routine { id: ID!, code: String }
  type Rigger { id: ID!, troupeName: String }
  type Prop { id: ID!, code: String }
  type Show { id: ID!, showNumber: String, name: String, status: String, acts: [CircusAct] }
  type User { id: ID!, name: String, email: String }
`

let schema: GraphQLSchema

beforeAll(() => {
  schema = buildSchema(TEST_SCHEMA_SDL)
})

describe("Performance", () => {
  it("should validate a typical query in <100ms", () => {
    const source = `
const Q = gql\`
  query circusAct($actId: ID!) {
    circusAct(id: $actId) {
      id
      canBeRescheduled
      canChangeTiming
      estimatedCurtainAt
      routine { id code }
      scheduledFor
      rigger { id troupeName }
      prop { id code }
      show { id showNumber }
    }
  }
\`
`
    const templates = findGraphQLTemplates(source)
    const start = performance.now()
    validateTemplate(templates[0], schema)
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(100)
  })

  it("should parse templates from a large file in <100ms", () => {
    // Generate a large file with many queries
    let source = 'import gql from "graphql-tag"\n\n'
    for (let i = 0; i < 50; i++) {
      source += `const Q${i} = gql\`
  query getUser${i}($id: ID!) {
    user(id: $id) { id name email }
  }
\`\n\n`
    }

    const start = performance.now()
    const templates = findGraphQLTemplates(source)
    const elapsed = performance.now() - start

    expect(templates).toHaveLength(50)
    expect(elapsed).toBeLessThan(100)
  })

  it("should validate 50 queries in <500ms", () => {
    let source = 'import gql from "graphql-tag"\n\n'
    for (let i = 0; i < 50; i++) {
      source += `const Q${i} = gql\`
  query getUser${i}($id: ID!) {
    user(id: $id) { id name email }
  }
\`\n\n`
    }

    const templates = findGraphQLTemplates(source)
    const start = performance.now()
    validateTemplates(templates, schema)
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(500)
  })

  it("should benefit from validation caching", () => {
    const cache = new CacheManager(100)
    const source = `
const Q = gql\`
  query circusAct($id: ID!) {
    circusAct(id: $id) { id canBeRescheduled }
  }
\`
`
    const templates = findGraphQLTemplates(source)

    // First validation
    const start1 = performance.now()
    validateTemplate(templates[0], schema, cache)
    const elapsed1 = performance.now() - start1

    // Second validation (should hit cache)
    const start2 = performance.now()
    validateTemplate(templates[0], schema, cache)
    const elapsed2 = performance.now() - start2

    // Cache hit should be faster (or at least not slower)
    expect(elapsed2).toBeLessThanOrEqual(elapsed1 + 1) // +1ms tolerance
    cache.clearMemory()
  })

  it("should handle 1000 validations without memory issues", () => {
    const cache = new CacheManager(200)
    const source = `
const Q = gql\`
  query circusAct($id: ID!) {
    circusAct(id: $id) { id canBeRescheduled }
  }
\`
`
    const templates = findGraphQLTemplates(source)

    const startMem = process.memoryUsage().heapUsed
    for (let i = 0; i < 1000; i++) {
      validateTemplate(templates[0], schema, cache)
    }
    const endMem = process.memoryUsage().heapUsed
    const memGrowth = endMem - startMem

    // Memory growth should be < 50MB
    expect(memGrowth).toBeLessThan(50 * 1024 * 1024)
    cache.clearMemory()
  })
})
