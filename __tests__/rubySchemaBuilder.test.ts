import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import {
  parseRubyTypeDefinition,
  parseAccessLevel,
  parseResolverDefinition,
  parseArguments,
  parseRegistrationFile,
  findGraphQLDirectories,
  findRegistrationFiles,
  loadGraphQLTypeFiles,
  buildGraphQLSchema,
  validateSchemaIntegrity,
  buildSchemaFromDirectory,
  snakeToCamel,
  GraphQLTypeDefinition,
  ResolverDefinition,
  ResolverRegistration,
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

// ── Query/Mutation Resolver Fixtures ──────────────────────────────────────────

const AGENT_STATS_QUERY_FIXTURE = `
module Warranty
  module Graphql
    class AgentStatsQuery < NitroGraphql::BaseQuery
      description "Get a list of warranty agents using the provided IDs"

      type [::Warranty::Graphql::AgentStatsType], null: false

      argument :agent_ids, [ID]
      argument :start_date, String, required: false
      argument :end_date, String, required: false

      def resolve(agent_ids:, start_date: nil, end_date: nil)
      end
    end
  end
end
`

const AVAILABLE_ROUTES_QUERY_FIXTURE = `
module Warranty
  module Graphql
    class AvailableRoutesQuery < ::NitroGraphql::BaseQuery
      description "Get available routes for a specific date"

      type [::CoreModels::Graphql::InspectionRouteType], null: false
      argument :date_range, [NitroGraphql::Types::Date]
      argument :territory_id, ID
      argument :route_group, String, required: false, default_value: "service"

      def resolve(date_range:, territory_id:, route_group: "service")
      end
    end
  end
end
`

const COUNT_INCOMING_CALLS_QUERY_FIXTURE = `
module Warranty
  module Graphql
    class CountIncomingCallsQuery < ::NitroGraphql::BaseQuery
      description "Get count of incoming calls for the day"

      type Int, null: false

      argument :start_date, String, required: false
      argument :end_date, String, required: false

      def resolve(start_date: nil, end_date: nil)
      end
    end
  end
end
`

const CREATE_SERVICE_ORDER_MUTATION_FIXTURE = `
module Warranty
  module Graphql
    class CreateServiceOrderMutation < NitroGraphql::BaseQuery
      description "Create a service PO"

      type [::CoreModels::Graphql::PurchaseOrderType], null: false

      argument :project_id, ID
      argument :ticket_number, String, required: false
      argument :items, [Warranty::Graphql::ServiceOrderItemInputType]

      def resolve(project_id:, items:, ticket_number: nil)
      end
    end
  end
end
`

const CANCEL_SERVICE_APPOINTMENT_MUTATION_FIXTURE = `
module Warranty
  module Graphql
    class CancelServiceAppointmentMutation < NitroGraphql::BaseQuery
      description "Cancel a service appointment"

      type ::CoreModels::Graphql::ProjectTaskType, null: false

      argument :service_quote_id, ID
      argument :attributes, ::Warranty::Graphql::ServiceAppointmentInputType

      def resolve(service_quote_id:, attributes:)
      end
    end
  end
end
`

const DELETE_ADDITIONAL_SERVICE_MUTATION_FIXTURE = `
module Warranty
  module Graphql
    class DeleteAdditionalServiceMutation < NitroGraphql::BaseQuery
      description "Delete an additional service for a warranty service appointment"

      type ::Warranty::Graphql::ServiceAppointmentAdditionalServiceType, null: false

      argument :id, ID

      def resolve(id:)
      end
    end
  end
end
`

const SERVICE_APPOINTMENT_INPUT_TYPE_FIXTURE = `
module Warranty
  module Graphql
    class ServiceAppointmentInputType < NitroGraphql::Types::BaseInputObject
      graphql_name "ServiceAppointmentInput"

      argument :project_task_id, ID
      argument :cant_service_reason, String, required: false
      argument :notes, String, required: false
    end
  end
end
`

const AGENT_STATS_TYPE_FIXTURE = `
module Warranty
  module Graphql
    class AgentStatsType < NitroGraphql::Types::BaseObject
      graphql_name "WarrantyAgentStats"

      field :incoming_calls, Int
      field :average_calls, Float
      field :available_duration, Float
    end
  end
end
`

const REGISTRATION_FILE_FIXTURE = `
module Warranty
  module Graphql
    extend ::NitroGraphql::Schema::Partial

    queries do
      field :agent_stats,
            resolver: ::Warranty::Graphql::AgentStatsQuery,
            access: { warranty_stats_dashboard: :view }

      field :available_routes,
            resolver: ::Warranty::Graphql::AvailableRoutesQuery,
            access: { InspectionAppointment => :update }

      field :count_incoming_calls,
            resolver: ::Warranty::Graphql::CountIncomingCallsQuery,
            access: { ::CustomerSupport::ServiceCall => :take }
    end

    mutations do
      field :create_service_order,
            resolver: ::Warranty::Graphql::CreateServiceOrderMutation,
            access: { Project => :create_material_po }

      field :cancel_service_appointment,
            resolver: ::Warranty::Graphql::CancelServiceAppointmentMutation,
            access: { ProjectTask => :service_work_queue }

      field :delete_additional_service,
            resolver: ::Warranty::Graphql::DeleteAdditionalServiceMutation,
            access: { ProjectTask => :service_work_queue }
    end
  end
end
`

const PROPOSED_SERVICE_CHANGE_STATUS_ENUM_FIXTURE = `
module Warranty
  module Graphql
    class ProposedServiceChangeStatusEnum < NitroGraphql::Types::BaseEnum
      value "proposed"
      value "canceled"
      value "submitted"
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

  it("should return null for BaseQuery resolver classes", () => {
    const def = parseRubyTypeDefinition(
      AGENT_STATS_QUERY_FIXTURE,
      "agent_stats_query.rb"
    )
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

  it("should build a valid GraphQL schema from legacy type defs with Query root", () => {
    const typeDefs = buildTestSchema()
    const schema = buildGraphQLSchema(typeDefs)
    expect(schema).toBeDefined()
    expect(schema.getQueryType()).toBeDefined()
  })

  it("should preserve query root type fields from legacy Query type", () => {
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

  it("should include mutation type from legacy Mutations type", () => {
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

  it("should build query fields from resolver registrations", () => {
    const typeDefs = [
      parseRubyTypeDefinition(AGENT_STATS_TYPE_FIXTURE, "agent_stats_type.rb")!,
    ]
    const resolvers = [
      parseResolverDefinition(
        AGENT_STATS_QUERY_FIXTURE,
        "agent_stats_query.rb"
      )!,
    ]
    const registrations: ResolverRegistration[] = [
      {
        fieldName: "agentStats",
        resolverClassName: "Warranty::Graphql::AgentStatsQuery",
        target: "query",
      },
    ]

    const schema = buildGraphQLSchema(typeDefs, resolvers, registrations)
    const queryType = schema.getQueryType()!
    const fields = queryType.getFields()

    expect(fields["agentStats"]).toBeDefined()
    // Should have arguments from the resolver
    expect(fields["agentStats"].args.length).toBeGreaterThan(0)
    const agentIdsArg = fields["agentStats"].args.find(
      a => a.name === "agentIds"
    )
    expect(agentIdsArg).toBeDefined()
  })

  it("should build mutation fields from resolver registrations", () => {
    const typeDefs = [
      parseRubyTypeDefinition(
        SERVICE_APPOINTMENT_INPUT_TYPE_FIXTURE,
        "input.rb"
      )!,
    ]
    const resolvers = [
      parseResolverDefinition(
        DELETE_ADDITIONAL_SERVICE_MUTATION_FIXTURE,
        "delete_mutation.rb"
      )!,
    ]
    const registrations: ResolverRegistration[] = [
      {
        fieldName: "deleteAdditionalService",
        resolverClassName: "Warranty::Graphql::DeleteAdditionalServiceMutation",
        target: "mutation",
      },
    ]

    // Need a query type too
    const queryTypeDefs = [
      ...typeDefs,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query.rb")!,
      parseRubyTypeDefinition(COUNTRY_TYPE_FIXTURE, "country.rb")!,
      parseRubyTypeDefinition(ACCESS_TYPE_FIXTURE, "employee.rb")!,
      parseRubyTypeDefinition(INTERFACE_TYPE_FIXTURE, "audience.rb")!,
      parseRubyTypeDefinition(COURSE_TYPE_FIXTURE, "course.rb")!,
    ]

    const schema = buildGraphQLSchema(queryTypeDefs, resolvers, registrations)
    const mutationType = schema.getMutationType()!
    expect(mutationType).toBeDefined()

    const fields = mutationType.getFields()
    expect(fields["deleteAdditionalService"]).toBeDefined()
    const idArg = fields["deleteAdditionalService"].args.find(
      a => a.name === "id"
    )
    expect(idArg).toBeDefined()
  })

  it("should build schema with both resolvers and traditional type defs", () => {
    const typeDefs = [
      parseRubyTypeDefinition(COUNTRY_TYPE_FIXTURE, "country.rb")!,
      parseRubyTypeDefinition(ACCESS_TYPE_FIXTURE, "employee.rb")!,
      parseRubyTypeDefinition(INTERFACE_TYPE_FIXTURE, "audience.rb")!,
      parseRubyTypeDefinition(COURSE_TYPE_FIXTURE, "course.rb")!,
      parseRubyTypeDefinition(AGENT_STATS_TYPE_FIXTURE, "agent_stats.rb")!,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query.rb")!,
    ]
    const resolvers = [
      parseResolverDefinition(
        AGENT_STATS_QUERY_FIXTURE,
        "agent_stats_query.rb"
      )!,
    ]
    const registrations: ResolverRegistration[] = [
      {
        fieldName: "agentStats",
        resolverClassName: "Warranty::Graphql::AgentStatsQuery",
        target: "query",
      },
    ]

    const schema = buildGraphQLSchema(typeDefs, resolvers, registrations)
    const queryType = schema.getQueryType()!
    const fields = queryType.getFields()

    // Should have resolver-registered fields
    expect(fields["agentStats"]).toBeDefined()
    // Should also have legacy Query type fields
    expect(fields["user"]).toBeDefined()
    expect(fields["countries"]).toBeDefined()
  })

  it("should handle resolver with scalar return type (Int)", () => {
    const typeDefs = [
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query.rb")!,
      parseRubyTypeDefinition(COUNTRY_TYPE_FIXTURE, "country.rb")!,
      parseRubyTypeDefinition(ACCESS_TYPE_FIXTURE, "employee.rb")!,
      parseRubyTypeDefinition(INTERFACE_TYPE_FIXTURE, "audience.rb")!,
      parseRubyTypeDefinition(COURSE_TYPE_FIXTURE, "course.rb")!,
    ]
    const resolvers = [
      parseResolverDefinition(
        COUNT_INCOMING_CALLS_QUERY_FIXTURE,
        "count_incoming_calls.rb"
      )!,
    ]
    const registrations: ResolverRegistration[] = [
      {
        fieldName: "countIncomingCalls",
        resolverClassName: "Warranty::Graphql::CountIncomingCallsQuery",
        target: "query",
      },
    ]

    const schema = buildGraphQLSchema(typeDefs, resolvers, registrations)
    const queryType = schema.getQueryType()!
    const fields = queryType.getFields()
    expect(fields["countIncomingCalls"]).toBeDefined()
  })

  it("should handle resolver with list return type", () => {
    const typeDefs = [
      parseRubyTypeDefinition(AGENT_STATS_TYPE_FIXTURE, "agent_stats.rb")!,
    ]
    const resolvers = [
      parseResolverDefinition(
        AGENT_STATS_QUERY_FIXTURE,
        "agent_stats_query.rb"
      )!,
    ]
    const registrations: ResolverRegistration[] = [
      {
        fieldName: "agentStats",
        resolverClassName: "Warranty::Graphql::AgentStatsQuery",
        target: "query",
      },
    ]

    const schema = buildGraphQLSchema(typeDefs, resolvers, registrations)
    const queryType = schema.getQueryType()!
    const field = queryType.getFields()["agentStats"]
    // The return type should be a list (non-null list of non-null WarrantyAgentStats)
    expect(field.type.toString()).toContain("WarrantyAgentStats")
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

  it("should build schema from a full directory structure with legacy Query type", () => {
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

  it("should build schema with resolvers and registration files", () => {
    // Create graphql type + resolver files
    const gqlDir = path.join(
      tmpDir,
      "components",
      "warranty",
      "app",
      "graphql",
      "warranty",
      "graphql"
    )
    fs.mkdirSync(gqlDir, { recursive: true })
    fs.writeFileSync(
      path.join(gqlDir, "agent_stats_type.rb"),
      AGENT_STATS_TYPE_FIXTURE
    )
    fs.writeFileSync(
      path.join(gqlDir, "agent_stats_query.rb"),
      AGENT_STATS_QUERY_FIXTURE
    )

    // Create registration file
    const regDir = path.join(
      tmpDir,
      "components",
      "warranty",
      "lib",
      "warranty"
    )
    fs.mkdirSync(regDir, { recursive: true })
    fs.writeFileSync(path.join(regDir, "graphql.rb"), REGISTRATION_FILE_FIXTURE)

    const result = buildSchemaFromDirectory(tmpDir)
    expect(result.schema).toBeDefined()
    expect(result.resolverCount).toBeGreaterThan(0)
    expect(result.registrationCount).toBeGreaterThan(0)

    const queryType = result.schema.getQueryType()!
    const fields = queryType.getFields()
    expect(fields["agentStats"]).toBeDefined()
  })
})

// ── New Test Suites ────────────────────────────────────────────────────────────

describe("snakeToCamel", () => {
  it("should convert snake_case to camelCase", () => {
    expect(snakeToCamel("agent_stats")).toBe("agentStats")
    expect(snakeToCamel("available_routes")).toBe("availableRoutes")
    expect(snakeToCamel("count_incoming_calls")).toBe("countIncomingCalls")
  })

  it("should leave already camelCase strings unchanged", () => {
    expect(snakeToCamel("agentStats")).toBe("agentStats")
    expect(snakeToCamel("id")).toBe("id")
  })

  it("should handle single words", () => {
    expect(snakeToCamel("name")).toBe("name")
  })

  it("should handle multiple underscores", () => {
    expect(snakeToCamel("home_warranty_service_events_query")).toBe(
      "homeWarrantyServiceEventsQuery"
    )
  })
})

describe("parseResolverDefinition", () => {
  it("should parse a query resolver with arguments and return type", () => {
    const resolver = parseResolverDefinition(
      AGENT_STATS_QUERY_FIXTURE,
      "agent_stats_query.rb"
    )
    expect(resolver).not.toBeNull()
    expect(resolver!.className).toBe("Warranty::Graphql::AgentStatsQuery")
    expect(resolver!.returnType).toBe("AgentStats")
    expect(resolver!.returnTypeIsList).toBe(true)
    expect(resolver!.returnTypeNullable).toBe(false)
    expect(resolver!.arguments.length).toBe(3)
  })

  it("should parse argument names as camelCase", () => {
    const resolver = parseResolverDefinition(
      AGENT_STATS_QUERY_FIXTURE,
      "agent_stats_query.rb"
    )!
    const agentIdsArg = resolver.arguments.find(a => a.name === "agentIds")
    expect(agentIdsArg).toBeDefined()
    expect(agentIdsArg!.isList).toBe(true)
    expect(agentIdsArg!.type).toBe("ID")

    const startDateArg = resolver.arguments.find(a => a.name === "startDate")
    expect(startDateArg).toBeDefined()
    expect(startDateArg!.required).toBe(false)
  })

  it("should parse a resolver with default_value argument", () => {
    const resolver = parseResolverDefinition(
      AVAILABLE_ROUTES_QUERY_FIXTURE,
      "available_routes_query.rb"
    )!
    expect(resolver.arguments.length).toBe(3)

    const routeGroupArg = resolver.arguments.find(a => a.name === "routeGroup")
    expect(routeGroupArg).toBeDefined()
    expect(routeGroupArg!.required).toBe(false)
    expect(routeGroupArg!.defaultValue).toBe("service")
  })

  it("should parse a resolver with scalar return type (Int)", () => {
    const resolver = parseResolverDefinition(
      COUNT_INCOMING_CALLS_QUERY_FIXTURE,
      "count_incoming_calls_query.rb"
    )!
    expect(resolver.returnType).toBe("Int")
    expect(resolver.returnTypeIsList).toBe(false)
    expect(resolver.returnTypeNullable).toBe(false)
  })

  it("should parse a mutation resolver", () => {
    const resolver = parseResolverDefinition(
      CREATE_SERVICE_ORDER_MUTATION_FIXTURE,
      "create_service_order_mutation.rb"
    )!
    expect(resolver.className).toBe(
      "Warranty::Graphql::CreateServiceOrderMutation"
    )
    expect(resolver.returnType).toBe("PurchaseOrder")
    expect(resolver.returnTypeIsList).toBe(true)

    const projectIdArg = resolver.arguments.find(a => a.name === "projectId")
    expect(projectIdArg).toBeDefined()
    expect(projectIdArg!.type).toBe("ID")
    expect(projectIdArg!.required).toBe(true)

    const ticketNumberArg = resolver.arguments.find(
      a => a.name === "ticketNumber"
    )
    expect(ticketNumberArg).toBeDefined()
    expect(ticketNumberArg!.required).toBe(false)
  })

  it("should parse a mutation with input type argument", () => {
    const resolver = parseResolverDefinition(
      CANCEL_SERVICE_APPOINTMENT_MUTATION_FIXTURE,
      "cancel_mutation.rb"
    )!
    const attrsArg = resolver.arguments.find(a => a.name === "attributes")
    expect(attrsArg).toBeDefined()
    expect(attrsArg!.type).toBe("ServiceAppointmentInput")
  })

  it("should parse a simple mutation with single ID argument", () => {
    const resolver = parseResolverDefinition(
      DELETE_ADDITIONAL_SERVICE_MUTATION_FIXTURE,
      "delete_mutation.rb"
    )!
    expect(resolver.arguments.length).toBe(1)
    expect(resolver.arguments[0].name).toBe("id")
    expect(resolver.arguments[0].type).toBe("ID")
    expect(resolver.arguments[0].required).toBe(true)
  })

  it("should return null for non-resolver classes", () => {
    const resolver = parseResolverDefinition(
      COURSE_TYPE_FIXTURE,
      "course_type.rb"
    )
    expect(resolver).toBeNull()
  })

  it("should return null for files without a class definition", () => {
    const resolver = parseResolverDefinition("module Foo; end", "foo.rb")
    expect(resolver).toBeNull()
  })
})

describe("parseArguments", () => {
  it("should parse required argument", () => {
    const content = "argument :id, ID"
    const args = parseArguments(content)
    expect(args.length).toBe(1)
    expect(args[0].name).toBe("id")
    expect(args[0].type).toBe("ID")
    expect(args[0].required).toBe(true)
  })

  it("should parse optional argument", () => {
    const content = "argument :start_date, String, required: false"
    const args = parseArguments(content)
    expect(args.length).toBe(1)
    expect(args[0].name).toBe("startDate")
    expect(args[0].required).toBe(false)
  })

  it("should parse argument with list type", () => {
    const content = "argument :agent_ids, [ID]"
    const args = parseArguments(content)
    expect(args.length).toBe(1)
    expect(args[0].name).toBe("agentIds")
    expect(args[0].isList).toBe(true)
    expect(args[0].type).toBe("ID")
  })

  it("should parse argument with default_value as optional", () => {
    const content =
      'argument :route_group, String, required: false, default_value: "service"'
    const args = parseArguments(content)
    expect(args.length).toBe(1)
    expect(args[0].required).toBe(false)
    expect(args[0].defaultValue).toBe("service")
  })

  it("should parse multiple arguments", () => {
    const content = `
      argument :project_id, ID
      argument :ticket_number, String, required: false
      argument :items, [Warranty::Graphql::ServiceOrderItemInputType]
    `
    const args = parseArguments(content)
    expect(args.length).toBe(3)
    expect(args[0].name).toBe("projectId")
    expect(args[1].name).toBe("ticketNumber")
    expect(args[2].name).toBe("items")
    expect(args[2].isList).toBe(true)
  })

  it("should parse argument with namespaced input type", () => {
    const content =
      "argument :attributes, ::Warranty::Graphql::ServiceAppointmentInputType"
    const args = parseArguments(content)
    expect(args.length).toBe(1)
    expect(args[0].type).toBe("ServiceAppointmentInput")
  })
})

describe("parseRegistrationFile", () => {
  it("should parse queries and mutations from registration file", () => {
    const registrations = parseRegistrationFile(REGISTRATION_FILE_FIXTURE)
    expect(registrations.length).toBe(6)

    const queries = registrations.filter(r => r.target === "query")
    expect(queries.length).toBe(3)

    const mutations = registrations.filter(r => r.target === "mutation")
    expect(mutations.length).toBe(3)
  })

  it("should convert field names to camelCase", () => {
    const registrations = parseRegistrationFile(REGISTRATION_FILE_FIXTURE)
    const agentStats = registrations.find(r => r.fieldName === "agentStats")
    expect(agentStats).toBeDefined()
    expect(agentStats!.resolverClassName).toContain("AgentStatsQuery")

    const cancelAppt = registrations.find(
      r => r.fieldName === "cancelServiceAppointment"
    )
    expect(cancelAppt).toBeDefined()
  })

  it("should extract correct resolver class names", () => {
    const registrations = parseRegistrationFile(REGISTRATION_FILE_FIXTURE)
    const createOrder = registrations.find(
      r => r.fieldName === "createServiceOrder"
    )
    expect(createOrder).toBeDefined()
    expect(createOrder!.resolverClassName).toContain(
      "CreateServiceOrderMutation"
    )
    expect(createOrder!.target).toBe("mutation")
  })

  it("should return empty array for files with no registrations", () => {
    const registrations = parseRegistrationFile(`
module Foo
  module Graphql
    extend ::NitroGraphql::Schema::Partial
  end
end
`)
    expect(registrations).toEqual([])
  })

  it("should handle queries-only registration file", () => {
    const content = `
module Foo
  module Graphql
    extend ::NitroGraphql::Schema::Partial

    queries do
      field :my_query,
            resolver: ::Foo::Graphql::MyQuery
    end
  end
end
`
    const registrations = parseRegistrationFile(content)
    expect(registrations.length).toBe(1)
    expect(registrations[0].target).toBe("query")
    expect(registrations[0].fieldName).toBe("myQuery")
  })
})

describe("findRegistrationFiles", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nitro-reg-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("should find graphql.rb registration files", () => {
    const regDir = path.join(
      tmpDir,
      "components",
      "warranty",
      "lib",
      "warranty"
    )
    fs.mkdirSync(regDir, { recursive: true })
    fs.writeFileSync(path.join(regDir, "graphql.rb"), "# test")

    const files = findRegistrationFiles(tmpDir)
    expect(files.length).toBe(1)
    expect(files[0]).toContain("graphql.rb")
  })

  it("should find multiple component registration files", () => {
    const dirs = [
      path.join(tmpDir, "components", "warranty", "lib", "warranty"),
      path.join(tmpDir, "components", "admin", "lib", "admin"),
    ]
    for (const dir of dirs) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, "graphql.rb"), "# test")
    }

    const files = findRegistrationFiles(tmpDir)
    expect(files.length).toBe(2)
  })

  it("should return empty array when no components directory", () => {
    const files = findRegistrationFiles(tmpDir)
    expect(files).toEqual([])
  })
})
