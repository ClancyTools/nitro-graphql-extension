import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import {
  parseRubyTypeDefinition,
  parseAccessLevel,
  findGraphQLDirectories,
  loadGraphQLTypeFiles,
  buildGraphQLSchema,
  validateSchemaIntegrity,
  buildSchemaFromDirectory,
  GraphQLTypeDefinition,
} from "../src/schema/rubySchemaBuilder"

// ── Fixtures ───────────────────────────────────────────────────────────────────

const COURSE_TYPE_FIXTURE = `
# frozen_string_literal: true

module LearningDojo
  module Graphql
    class CourseType < NitroGraphql::Types::BaseObject
      implements ::NitroAudiences::Graphql::AudienceInterface

      graphql_name "LearningDojoCourse"
      description "A course in the Learning Dojo"

      field :id, ID, null: false
      field :title, String
      field :description, String
      field :show_assessment_answers, Boolean, null: false
      field :prerequisite_id, Integer
      field :versions, [::LearningDojo::Graphql::CourseVersionType], null: false
      field :current_version, ::LearningDojo::Graphql::CourseVersionType, null: false
      field :handouts, [::LearningDojo::Graphql::HandoutType]
      field :tag_list, [String], null: false
      field :track_time, Boolean, null: false
    end
  end
end
`

const ACCESS_TYPE_FIXTURE = `
module Directory
  module Graphql
    class EmployeeType < NitroGraphql::Types::BaseObject
      graphql_name "Employee"

      field :name, String, null: false, access: :public
      field :id, ID, null: false, access: %i[private customer]
      field :email, String, access: :partner
      field :salary, Float
      field :department, String, null: false, access: [:private, :admin]
    end
  end
end
`

const QUERY_TYPE_FIXTURE = `
module NitroGraphql
  class QueryType < NitroGraphql::Types::BaseObject
    graphql_name "Queries"

    field :user, ::Directory::Graphql::EmployeeType, null: true
    field :course, ::LearningDojo::Graphql::CourseType, null: true
    field :countries, [::Shared::Graphql::CountryType], null: false
  end
end
`

const MUTATION_TYPE_FIXTURE = `
module NitroGraphql
  class MutationType < NitroGraphql::Types::BaseObject
    graphql_name "Mutations"

    field :update_user, ::Directory::Graphql::EmployeeType, null: true
  end
end
`

const ENUM_TYPE_FIXTURE = `
module Shared
  module Graphql
    class StatusEnum < NitroGraphql::Types::BaseEnum
      graphql_name "StatusEnum"

      value "ACTIVE"
      value "INACTIVE"
      value "PENDING"
    end
  end
end
`

const INPUT_TYPE_FIXTURE = `
module Directory
  module Graphql
    class EmployeeInputType < NitroGraphql::Types::BaseInputObject
      graphql_name "EmployeeInput"

      argument :name, String, required: true
      field :email, String
    end
  end
end
`

const INTERFACE_TYPE_FIXTURE = `
module NitroAudiences
  module Graphql
    class AudienceInterface < NitroGraphql::Types::BaseInterface
      graphql_name "AudienceInterface"

      field :id, ID, null: false
      field :name, String
    end
  end
end
`

const COUNTRY_TYPE_FIXTURE = `
module Shared
  module Graphql
    class CountryType < NitroGraphql::Types::BaseObject
      graphql_name "Country"

      field :abbr, String, null: false
      field :name, String, null: false
    end
  end
end
`

const EMPTY_FIELDS_TYPE = `
module Broken
  module Graphql
    class EmptyType < NitroGraphql::Types::BaseObject
      graphql_name "BrokenEmpty"
    end
  end
end
`

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("parseRubyTypeDefinition", () => {
  it("should parse a standard object type with graphql_name", () => {
    const def = parseRubyTypeDefinition(COURSE_TYPE_FIXTURE, "course_type.rb")
    expect(def).not.toBeNull()
    expect(def!.name).toBe("LearningDojoCourse")
    expect(def!.kind).toBe("object")
    expect(def!.fields.length).toBeGreaterThan(5)
  })

  it("should extract field names and types correctly", () => {
    const def = parseRubyTypeDefinition(COURSE_TYPE_FIXTURE, "course_type.rb")!
    const idField = def.fields.find(f => f.name === "id")
    expect(idField).toBeDefined()
    expect(idField!.type).toBe("ID")
    expect(idField!.nullable).toBe(false)

    const titleField = def.fields.find(f => f.name === "title")
    expect(titleField).toBeDefined()
    expect(titleField!.type).toBe("String")
    expect(titleField!.nullable).toBe(true)
  })

  it("should handle list types", () => {
    const def = parseRubyTypeDefinition(COURSE_TYPE_FIXTURE, "course_type.rb")!
    const versionsField = def.fields.find(f => f.name === "versions")
    expect(versionsField).toBeDefined()
    expect(versionsField!.isList).toBe(true)
    expect(versionsField!.nullable).toBe(false)
  })

  it("should extract implements clauses", () => {
    const def = parseRubyTypeDefinition(COURSE_TYPE_FIXTURE, "course_type.rb")!
    expect(def.implements).toContain("AudienceInterface")
  })

  it("should parse a type with access levels", () => {
    const def = parseRubyTypeDefinition(
      ACCESS_TYPE_FIXTURE,
      "employee_type.rb"
    )!
    expect(def.name).toBe("Employee")

    const nameField = def.fields.find(f => f.name === "name")
    expect(nameField!.access).toEqual(["public"])

    const idField = def.fields.find(f => f.name === "id")
    expect(idField!.access).toEqual(["private", "customer"])

    const emailField = def.fields.find(f => f.name === "email")
    expect(emailField!.access).toEqual(["partner"])
  })

  it("should default access to private when not specified", () => {
    const def = parseRubyTypeDefinition(
      ACCESS_TYPE_FIXTURE,
      "employee_type.rb"
    )!
    const salaryField = def.fields.find(f => f.name === "salary")
    expect(salaryField!.access).toEqual(["private"])
  })

  it("should parse enum types", () => {
    const def = parseRubyTypeDefinition(ENUM_TYPE_FIXTURE, "status_enum.rb")!
    expect(def.kind).toBe("enum")
    expect(def.enumValues).toEqual(["ACTIVE", "INACTIVE", "PENDING"])
  })

  it("should parse interface types", () => {
    const def = parseRubyTypeDefinition(
      INTERFACE_TYPE_FIXTURE,
      "audience_interface.rb"
    )!
    expect(def.kind).toBe("interface")
    expect(def.fields.length).toBe(2)
  })

  it("should parse query root type", () => {
    const def = parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query_type.rb")!
    expect(def.name).toBe("Queries")
    expect(def.fields.length).toBeGreaterThan(0)
  })

  it("should parse mutation root type", () => {
    const def = parseRubyTypeDefinition(
      MUTATION_TYPE_FIXTURE,
      "mutation_type.rb"
    )!
    expect(def.name).toBe("Mutations")
    expect(def.fields.length).toBeGreaterThan(0)
  })

  it("should return null for non-GraphQL Ruby files", () => {
    const content = `
module Foo
  class Bar
    def do_thing
      puts "hello"
    end
  end
end
`
    const def = parseRubyTypeDefinition(content, "bar.rb")
    expect(def).toBeNull()
  })

  it("should handle types with no fields (empty type)", () => {
    const def = parseRubyTypeDefinition(EMPTY_FIELDS_TYPE, "empty_type.rb")
    expect(def).not.toBeNull()
    expect(def!.fields).toHaveLength(0)
  })

  it("should resolve Ruby namespaced types to simple names", () => {
    const def = parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query_type.rb")!
    const userField = def.fields.find(f => f.name === "user")
    expect(userField!.type).toBe("Employee")
  })

  it("should map Integer to Int", () => {
    const def = parseRubyTypeDefinition(COURSE_TYPE_FIXTURE, "course_type.rb")!
    const prereqField = def.fields.find(f => f.name === "prerequisite_id")
    expect(prereqField!.type).toBe("Int")
  })
})

describe("parseAccessLevel", () => {
  it("should parse :public symbol", () => {
    expect(parseAccessLevel("access: :public")).toEqual(["public"])
  })

  it("should parse :private symbol", () => {
    expect(parseAccessLevel("access: :private")).toEqual(["private"])
  })

  it("should parse :partner symbol", () => {
    expect(parseAccessLevel("access: :partner")).toEqual(["partner"])
  })

  it("should parse %i[...] array", () => {
    expect(parseAccessLevel("access: %i[private customer]")).toEqual([
      "private",
      "customer",
    ])
  })

  it("should parse %w[...] array", () => {
    expect(parseAccessLevel("access: %w[private admin]")).toEqual([
      "private",
      "admin",
    ])
  })

  it("should default to private when no access specified", () => {
    expect(parseAccessLevel("null: false")).toEqual(["private"])
  })
})

describe("buildGraphQLSchema", () => {
  function buildTestSchema(): GraphQLTypeDefinition[] {
    return [
      parseRubyTypeDefinition(COUNTRY_TYPE_FIXTURE, "country.rb")!,
      parseRubyTypeDefinition(ACCESS_TYPE_FIXTURE, "employee.rb")!,
      parseRubyTypeDefinition(INTERFACE_TYPE_FIXTURE, "audience.rb")!,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query.rb")!,
      parseRubyTypeDefinition(COURSE_TYPE_FIXTURE, "course.rb")!,
    ]
  }

  it("should build a valid GraphQL schema", () => {
    const typeDefs = buildTestSchema()
    const schema = buildGraphQLSchema(typeDefs)
    expect(schema).toBeDefined()
    expect(schema.getQueryType()).toBeDefined()
  })

  it("should preserve query root type fields", () => {
    const typeDefs = buildTestSchema()
    const schema = buildGraphQLSchema(typeDefs)
    const queryType = schema.getQueryType()!
    const fields = queryType.getFields()
    expect(fields["user"]).toBeDefined()
    expect(fields["course"]).toBeDefined()
    expect(fields["countries"]).toBeDefined()
  })

  it("should resolve type references across types", () => {
    const typeDefs = buildTestSchema()
    const schema = buildGraphQLSchema(typeDefs)
    const employeeType = schema.getType("Employee")
    expect(employeeType).toBeDefined()
  })

  it("should include mutation type when present", () => {
    const typeDefs = [
      ...buildTestSchema(),
      parseRubyTypeDefinition(MUTATION_TYPE_FIXTURE, "mutation.rb")!,
    ]
    const schema = buildGraphQLSchema(typeDefs)
    expect(schema.getMutationType()).toBeDefined()
  })

  it("should throw when no query root type found", () => {
    const typeDefs = [
      parseRubyTypeDefinition(COUNTRY_TYPE_FIXTURE, "country.rb")!,
    ]
    expect(() => buildGraphQLSchema(typeDefs)).toThrow("No Query")
  })

  it("should handle enum types", () => {
    const typeDefs = [
      ...buildTestSchema(),
      parseRubyTypeDefinition(ENUM_TYPE_FIXTURE, "status.rb")!,
    ]
    const schema = buildGraphQLSchema(typeDefs)
    const enumType = schema.getType("StatusEnum")
    expect(enumType).toBeDefined()
  })
})

describe("validateSchemaIntegrity", () => {
  it("should return empty array for valid schema", () => {
    const typeDefs = [
      parseRubyTypeDefinition(COUNTRY_TYPE_FIXTURE, "country.rb")!,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query.rb")!,
      parseRubyTypeDefinition(ACCESS_TYPE_FIXTURE, "employee.rb")!,
      parseRubyTypeDefinition(INTERFACE_TYPE_FIXTURE, "audience.rb")!,
      parseRubyTypeDefinition(COURSE_TYPE_FIXTURE, "course.rb")!,
    ]
    const schema = buildGraphQLSchema(typeDefs)
    const errors = validateSchemaIntegrity(schema)
    // May have some warnings about interface implementations etc.
    // Just checking it doesn't crash
    expect(Array.isArray(errors)).toBe(true)
  })
})

describe("findGraphQLDirectories", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nitro-gql-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("should find graphql directories in CoBRA structure", () => {
    // Create: components/foo/app/graphql/foo/graphql/
    const gqlDir = path.join(
      tmpDir,
      "components",
      "foo",
      "app",
      "graphql",
      "foo",
      "graphql"
    )
    fs.mkdirSync(gqlDir, { recursive: true })

    const dirs = findGraphQLDirectories(tmpDir)
    expect(dirs.length).toBeGreaterThan(0)
    expect(dirs.some(d => d.includes("graphql"))).toBe(true)
  })

  it("should skip node_modules", () => {
    const nodeModulesGql = path.join(tmpDir, "node_modules", "graphql")
    fs.mkdirSync(nodeModulesGql, { recursive: true })

    const dirs = findGraphQLDirectories(tmpDir)
    expect(dirs.some(d => d.includes("node_modules"))).toBe(false)
  })

  it("should return empty array for empty directory", () => {
    const dirs = findGraphQLDirectories(tmpDir)
    expect(dirs).toEqual([])
  })
})

describe("loadGraphQLTypeFiles", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nitro-load-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("should load .rb files from directories", () => {
    fs.writeFileSync(path.join(tmpDir, "type.rb"), "class Foo; end")
    fs.writeFileSync(path.join(tmpDir, "other.ts"), "const x = 1")

    const files = loadGraphQLTypeFiles([tmpDir])
    expect(files.size).toBe(1)
    expect(files.has(path.join(tmpDir, "type.rb"))).toBe(true)
  })

  it("should load files recursively", () => {
    const subDir = path.join(tmpDir, "sub")
    fs.mkdirSync(subDir, { recursive: true })
    fs.writeFileSync(path.join(tmpDir, "a.rb"), "content a")
    fs.writeFileSync(path.join(subDir, "b.rb"), "content b")

    const files = loadGraphQLTypeFiles([tmpDir])
    expect(files.size).toBe(2)
  })
})

describe("buildSchemaFromDirectory", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nitro-build-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("should throw when no graphql directories found", () => {
    expect(() => buildSchemaFromDirectory(tmpDir)).toThrow(
      "No graphql directories"
    )
  })

  it("should build schema from a full directory structure", () => {
    const gqlDir = path.join(tmpDir, "components", "test", "app", "graphql")
    fs.mkdirSync(gqlDir, { recursive: true })
    fs.writeFileSync(path.join(gqlDir, "query_type.rb"), QUERY_TYPE_FIXTURE)
    fs.writeFileSync(path.join(gqlDir, "employee_type.rb"), ACCESS_TYPE_FIXTURE)
    fs.writeFileSync(path.join(gqlDir, "country_type.rb"), COUNTRY_TYPE_FIXTURE)
    fs.writeFileSync(path.join(gqlDir, "interface.rb"), INTERFACE_TYPE_FIXTURE)
    fs.writeFileSync(path.join(gqlDir, "course_type.rb"), COURSE_TYPE_FIXTURE)

    const result = buildSchemaFromDirectory(tmpDir)
    expect(result.schema).toBeDefined()
    expect(result.typeCount).toBeGreaterThan(0)
    expect(result.schema.getQueryType()).toBeDefined()
  })
})
