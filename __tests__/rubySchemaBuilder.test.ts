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
  parseMixinArguments,
  parseMixinRegistry,
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

      belongs_to :instructor, ::Directory::Graphql::EmployeeType, null: false
      belongs_to :category, ::LearningDojo::Graphql::CategoryType
      has_one :certificate, ::LearningDojo::Graphql::CertificateType
      has_one :featured_review, ::LearningDojo::Graphql::ReviewType, null: false
      has_many :enrollments, [::LearningDojo::Graphql::EnrollmentType]
      has_many :course_tags, [::LearningDojo::Graphql::CourseTagType], null: false
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

const AGENT_STATS_CONNECTION_QUERY_FIXTURE = `
module Warranty
  module Graphql
    class AgentStatsQuery < NitroGraphql::BaseQuery
      description "Get a list of warranty agents using the provided IDs"

      type ::Warranty::Graphql::AgentStatsType.connection_type, null: false

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

const TIME_OFF_BALANCE_TYPE_FIXTURE = `
module Attendance
  module Graphql
    class TimeOffBalanceType < NitroGraphql::Types::BaseObject
      field :hours, Float
      field :balance_type, String
    end
  end
end
`

const TIME_OFF_BALANCE_CONNECTION_QUERY_FIXTURE = `
module Attendance
  module Graphql
    class TimeOffBalanceQuery < NitroGraphql::BaseQuery
      description "Returns time off balance hours"

      type ::Attendance::Graphql::TimeOffBalanceType.connection_type, null: false
      argument :bucket, String
      argument :search, NitroGraphql::Types::Json, required: false

      def resolve(bucket:, search: {})
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

const CALENDAR_EVENT_TYPE_FIXTURE = `
module BrandHeadlines
  module Graphql
    class CalendarEventType < ::NitroGraphql::Types::BaseObject
      graphql_name "BrandHeadlinesCalendarEvent"

      field :id, ID, null: false
      field :title, String
      field :location, String
      field :start_date, NitroGraphql::Types::DateTime
      field :end_date, NitroGraphql::Types::DateTime
      field :details, String
    end
  end
end
`

const CALENDAR_EVENT_INPUT_FIXTURE = `
module BrandHeadlines
  module Graphql
    class CalendarEventInput < NitroGraphql::Types::BaseInputObject
      graphql_name "BrandHeadlinesCalendarEventInput"

      argument :id, ID, required: false
      argument :title, String
      argument :location, String
      argument :start_date, NitroGraphql::Types::DateTime
      argument :end_date, NitroGraphql::Types::DateTime
      argument :details, String, required: false
    end
  end
end
`

// A conflicting type in a different namespace with the same class name
const SPACES_CALENDAR_EVENT_TYPE_FIXTURE = `
module Spaces
  module Graphql
    class CalendarEventType < NitroGraphql::Types::BaseObject
      graphql_name "CalendarEvent"

      field :id, ID, null: false
      field :summary, String, null: false
      field :event_start, GraphQL::Types::ISO8601DateTime, null: false
    end
  end
end
`

// A conflicting input type in a different namespace with the same class name
const SPACES_CALENDAR_EVENT_INPUT_FIXTURE = `
module Spaces
  module Graphql
    class CalendarEventInput < NitroGraphql::Types::BaseInputObject
      graphql_name "CalendarEventInput"

      argument :summary, String
      argument :description, String, required: false
    end
  end
end
`

const CREATE_OR_UPDATE_CALENDAR_EVENT_MUTATION_FIXTURE = `
module BrandHeadlines
  module Graphql
    class CreateOrUpdateCalendarEventMutation < NitroGraphql::BaseQuery
      description "Creates or updates a calendar event"

      type ::BrandHeadlines::Graphql::CalendarEventType, null: false
      argument :input, ::BrandHeadlines::Graphql::CalendarEventInput

      def resolve(input:)
        input_hash = input.to_h
        if input_hash[:id].present?
          calendar_event = ::BrandHeadlines::CalendarEvent.find(input_hash.delete(:id))
          calendar_event.update!(input_hash)
          calendar_event
        else
          ::BrandHeadlines::CalendarEvent.create!(input_hash)
        end
      end
    end
  end
end
`

// ── EquipmentAsset disambiguation fixtures ─────────────────────────────────────

// Directory's richer version (graphql_name differs from normalized classBasedName)
const DIRECTORY_EQUIPMENT_ASSET_TYPE_FIXTURE = `
module Directory
  module Graphql
    class EquipmentAssetType < NitroGraphql::Types::BaseObject
      graphql_name "equipment_asset"
      description "A piece of equipment assigned to a user"

      field :id, ID, null: false
      field :asset_number, String, null: false
      field :serial_number, String
      field :status, String
    end
  end
end
`

// A separate, simpler type in a different namespace with the same class name
const EQUIPMENT_ASSETS_EQUIPMENT_ASSET_TYPE_FIXTURE = `
module EquipmentAssets
  module Graphql
    class EquipmentAssetType < NitroGraphql::Types::BaseObject
      graphql_name "EquipmentAsset"
      description "Equipment Asset info"

      field :id, ID, null: false
      field :type, String
      field :asset_number, String, null: false
    end
  end
end
`

// Employee type referencing Directory's version via fully-qualified path
const EMPLOYEE_WITH_EQUIPMENT_TYPE_FIXTURE = `
module Directory
  module Graphql
    class EmployeeType < NitroGraphql::Types::BaseObject
      graphql_name "Employee"

      field :id, ID, null: false
      field :name, String, null: false
      field :equipment_assets, [::Directory::Graphql::EquipmentAssetType]
    end
  end
end
`

// ── Nested resolver field fixtures ─────────────────────────────────────────────

const SUPPORT_PAGINATED_RESULT_TYPE_FIXTURE = `
module Support
  module Graphql
    class PaginatedTicketsResultType < NitroGraphql::Types::BaseObject
      graphql_name "PaginatedTicketsResult"

      field :total_count, Int, null: false
      field :tickets, [::Support::Graphql::TicketType]
    end
  end
end
`

const SUPPORT_TICKET_TYPE_FIXTURE = `
module Support
  module Graphql
    class TicketType < NitroGraphql::Types::BaseObject
      graphql_name "SupportTicket"

      field :id, ID, null: false
      field :ticket_number, String, null: false
    end
  end
end
`

const PAGINATED_TICKETS_QUERY_FIXTURE = `
module Support
  module Graphql
    class PaginatedTicketsQuery < NitroGraphql::BaseQuery
      description "Returns paginated support tickets"

      type ::Support::Graphql::PaginatedTicketsResultType, null: false
      argument :search, NitroGraphql::Types::Json, required: false
      argument :page, Int
      argument :per_page, Int

      def resolve(search: nil, page: 1, per_page: 10)
        # implementation
      end
    end
  end
end
`

// DomainType with a field backed by a resolver class
const SUPPORT_DOMAIN_TYPE_FIXTURE = `
module Support
  module Graphql
    class DomainType < NitroGraphql::Types::BaseObject
      graphql_name "SupportTicketDomain"

      field :id, ID, null: false
      field :name, String, null: false
      field :paginated_tickets, resolver: ::Support::Graphql::PaginatedTicketsQuery
    end
  end
end
`

// Test fixture for camelize: false option
const APPOINTMENT_TYPE_FIXTURE = `
module Scheduling
  module Graphql
    class AppointmentType < NitroGraphql::Types::BaseObject
      graphql_name "Appointment"
      description "A scheduled appointment"

      field :id, ID, null: false
      field :title, String, null: false
      # This field should NOT be camelCased because of camelize: false
      field :new_appts_plan, String, camelize: false
      # This field should be camelCased normally
      field :visit_time, String, null: false
      field :status_code, String, camelize: false
    end
  end
end
`

// Test fixture for array types with inline options
const PHONE_NUMBERS_TYPE_FIXTURE = `
module Directory
  module Graphql
    class PhoneNumberType < NitroGraphql::Types::BaseObject
      graphql_name "PhoneNumber"
      description "A phone number"

      field :extension, String
      field :number, String, null: false
    end
  end
end
`

// Type with a field using array syntax with inline options
const EMPLOYEE_WITH_PHONE_NUMBERS_FIXTURE = `
module Directory
  module Graphql
    class EmployeeType < NitroGraphql::Types::BaseObject
      graphql_name "Employee"

      field :id, ID, null: false
      field :name, String, null: false
      # This is the pattern that was breaking: [Type, { null: true }]
      # The parser should extract just "PhoneNumberType" and ignore the inline options
      field :phone_numbers, [NitroGraphql::CoreModels::PhoneNumberType, { null: true }], null: false
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

      field :access_before_resolver,
            access: :public,
            resolver: ::Warranty::Graphql::AgentStatsQuery
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

const PAGINATION_TYPE_FIXTURE = `
module NitroGraphql
  module Types
    class PaginationType < NitroGraphql::Types::BaseObject
      field :current_page, Integer, null: false
      field :total_pages, Integer, null: false
      field :total_entries, Integer, null: false
    end
  end
end
`

const PHONE_NUMBER_TYPE_FIXTURE = `
module NitroGraphql
  module CoreModels
    class PhoneNumberType < NitroGraphql::Types::BaseObject
      graphql_name "PhoneNumber"
      field :id, ID, null: false
      field :number, String, null: false
      field :number_type, String, null: false
    end
  end
end
`

const PROJECT_TASK_TYPE_FIXTURE = `
module CoreModels
  module Graphql
    class ProjectTaskType < NitroGraphql::Types::BaseObject
      graphql_name "ProjectTask"

      field :id, ID, null: false
      field :scheduled_date, String
      field :require_lead_safe_install, Boolean, null: false
      belongs_to :project, ::CoreModels::Graphql::ProjectType
      belongs_to :product, ::CoreModels::Graphql::ProductType
      belongs_to :inspection_appointment, ::CoreModels::Graphql::AppointmentType
    end
  end
end
`

const SERVICE_TASK_TYPE_FIXTURE = `
module Warranty
  module Graphql
    class ServiceTaskType < CoreModels::Graphql::ProjectTaskType
      graphql_name "WarantyServiceTask"

      field :warehouse, String
      field :pulse_enabled_homeowner_ids, [ID]
      field :active_service_quote, Warranty::Graphql::ServiceQuoteType
    end
  end
end
`

const POINT_OF_INTEREST_INPUT_TYPE_FIXTURE = `
module NitroGis
  module Graphql
    class PointOfInterestInputType < NitroGraphql::Types::BaseInputObject
      graphql_name "PointOfInterestInput"

      argument :name, String, required: false
      argument :latitude, Float, required: true
      argument :longitude, Float, required: true
    end
  end
end
`

const TERRITORY_ZONE_INPUT_TYPE_FIXTURE = `
module TerritoryMaps
  module Graphql
    class TerritoryExpansionCollectionZoneInputType < ::NitroGis::Graphql::PointOfInterestInputType
      graphql_name "TerritoryExpansionCollectionZoneInput"

      argument :id, ID, required: false
      argument :detail_name, String, required: false
      argument :color, String, required: false
    end
  end
end
`

const MODULE_INTERFACE_FIXTURE = `
module Warranty
  module Graphql
    module ServiceQuoteItemItemInterface
      include NitroGraphql::Types::BaseInterface

      field :id, ID, null: false
      field :model, String
      field :color, String
      field :serial_number, String

      belongs_to :product, ::CoreModels::Graphql::ProductType, null: false
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
    const prereqField = def.fields.find(f => f.name === "prerequisiteId")
    expect(prereqField!.type).toBe("Int")
  })

  it("should parse belongs_to as a non-list field in camelCase", () => {
    const def = parseRubyTypeDefinition(COURSE_TYPE_FIXTURE, "course_type.rb")!
    const instructorField = def.fields.find(f => f.name === "instructor")
    expect(instructorField).toBeDefined()
    expect(instructorField!.type).toBe("Employee")
    expect(instructorField!.isList).toBe(false)
    expect(instructorField!.nullable).toBe(false)

    const categoryField = def.fields.find(f => f.name === "category")
    expect(categoryField).toBeDefined()
    expect(categoryField!.type).toBe("Category")
    expect(categoryField!.isList).toBe(false)
    expect(categoryField!.nullable).toBe(true)
  })

  it("should parse has_one as a non-list field in camelCase", () => {
    const def = parseRubyTypeDefinition(COURSE_TYPE_FIXTURE, "course_type.rb")!
    const certField = def.fields.find(f => f.name === "certificate")
    expect(certField).toBeDefined()
    expect(certField!.type).toBe("Certificate")
    expect(certField!.isList).toBe(false)
    expect(certField!.nullable).toBe(true)

    const reviewField = def.fields.find(f => f.name === "featuredReview")
    expect(reviewField).toBeDefined()
    expect(reviewField!.type).toBe("Review")
    expect(reviewField!.isList).toBe(false)
    expect(reviewField!.nullable).toBe(false)
  })

  it("should parse has_many as a list field in camelCase", () => {
    const def = parseRubyTypeDefinition(COURSE_TYPE_FIXTURE, "course_type.rb")!
    const enrollmentsField = def.fields.find(f => f.name === "enrollments")
    expect(enrollmentsField).toBeDefined()
    expect(enrollmentsField!.type).toBe("Enrollment")
    expect(enrollmentsField!.isList).toBe(true)

    const courseTagsField = def.fields.find(f => f.name === "courseTags")
    expect(courseTagsField).toBeDefined()
    expect(courseTagsField!.type).toBe("CourseTag")
    expect(courseTagsField!.isList).toBe(true)
  })

  it("should parse type that inherits from a custom Type class", () => {
    const def = parseRubyTypeDefinition(
      SERVICE_TASK_TYPE_FIXTURE,
      "service_task_type.rb"
    )
    expect(def).not.toBeNull()
    expect(def!.kind).toBe("object")
    expect(def!.name).toBe("WarantyServiceTask")
    // Own fields should be present
    const warehouseField = def!.fields.find(f => f.name === "warehouse")
    expect(warehouseField).toBeDefined()
  })

  it("should parse InputType inheritance as kind input", () => {
    const def = parseRubyTypeDefinition(
      TERRITORY_ZONE_INPUT_TYPE_FIXTURE,
      "territory_zone_input_type.rb"
    )
    expect(def).not.toBeNull()
    expect(def!.kind).toBe("input")
    expect(def!.name).toBe("TerritoryExpansionCollectionZoneInput")
  })

  it("should parse argument declarations on input type as fields", () => {
    const def = parseRubyTypeDefinition(
      POINT_OF_INTEREST_INPUT_TYPE_FIXTURE,
      "point_of_interest_input_type.rb"
    )!
    const nameField = def.fields.find(f => f.name === "name")
    expect(nameField).toBeDefined()
    expect(nameField!.type).toBe("String")
    expect(nameField!.nullable).toBe(true) // required: false

    const latField = def.fields.find(f => f.name === "latitude")
    expect(latField).toBeDefined()
    expect(latField!.nullable).toBe(false) // required: true
  })

  it("should parse module-based interface (include BaseInterface)", () => {
    const def = parseRubyTypeDefinition(
      MODULE_INTERFACE_FIXTURE,
      "service_quote_item_item_interface.rb"
    )
    expect(def).not.toBeNull()
    expect(def!.kind).toBe("interface")
    // deriveTypeName does not strip "Interface" suffix, only "Type"
    expect(def!.name).toBe("ServiceQuoteItemItemInterface")
    // Should have parsed its fields
    const idField = def!.fields.find(f => f.name === "id")
    expect(idField).toBeDefined()
    const productField = def!.fields.find(f => f.name === "product")
    expect(productField).toBeDefined()
    expect(productField!.type).toBe("Product")
  })

  it("should respect camelize: false on field declarations", () => {
    // When a field declares camelize: false, its name should NOT be camelCased
    const def = parseRubyTypeDefinition(
      APPOINTMENT_TYPE_FIXTURE,
      "appointment_type.rb"
    )
    expect(def).not.toBeNull()

    // Field with camelize: false must keep snake_case
    const newApptsField = def!.fields.find(f => f.name === "new_appts_plan")
    expect(newApptsField).toBeDefined()
    expect(newApptsField!.type).toBe("String")
    expect(newApptsField!.camelize).toBe(false)

    const statusCodeField = def!.fields.find(f => f.name === "status_code")
    expect(statusCodeField).toBeDefined()
    expect(statusCodeField!.type).toBe("String")
    expect(statusCodeField!.camelize).toBe(false)

    // Field without camelize: false should be camelCased
    const visitTimeField = def!.fields.find(f => f.name === "visitTime")
    expect(visitTimeField).toBeDefined()
    expect(visitTimeField!.type).toBe("String")
    // camelize should be true (or omitted, which defaults to true)
    expect(visitTimeField!.camelize).not.toBe(false)

    // Wrong casing should NOT exist
    expect(def!.fields.find(f => f.name === "newApptsPlan")).toBeUndefined()
    expect(def!.fields.find(f => f.name === "visit_time")).toBeUndefined()
  })

  it("should parse array types with inline options correctly", () => {
    // When an array type includes inline options like [Type, { null: true }],
    // we should extract only the type name, not the options
    const def = parseRubyTypeDefinition(
      EMPLOYEE_WITH_PHONE_NUMBERS_FIXTURE,
      "employee_type.rb"
    )
    expect(def).not.toBeNull()

    const phoneNumbersField = def!.fields.find(f => f.name === "phoneNumbers")
    expect(phoneNumbersField).toBeDefined()
    // Type should be "PhoneNumber" (derived from PhoneNumberType after stripping inline options)
    expect(phoneNumbersField!.type).toBe("PhoneNumber")
    // Should be recognized as a list
    expect(phoneNumbersField!.isList).toBe(true)
    // Field-level null: false applies to the field itself (not nullable)
    expect(phoneNumbersField!.nullable).toBe(false)
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
    // Plain list returns are NOT wrapped in a Connection type
    expect(field.type.toString()).toContain("WarrantyAgentStats")
    expect(field.type.toString()).not.toContain("Connection")
  })

  it("should wrap .connection_type resolver in a Relay Connection type", () => {
    const typeDefs = [
      parseRubyTypeDefinition(AGENT_STATS_TYPE_FIXTURE, "agent_stats.rb")!,
    ]
    const resolvers = [
      parseResolverDefinition(
        AGENT_STATS_CONNECTION_QUERY_FIXTURE,
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

    // Return type should be a Connection, not a plain list
    expect(field.type.toString()).toContain("Connection")

    // Connection type should have nodes, edges, pageInfo, totalEntries
    const connectionType = schema.getType("WarrantyAgentStatsConnection") as any
    expect(connectionType).toBeDefined()
    const connectionFields = connectionType.getFields()
    expect(connectionFields["nodes"]).toBeDefined()
    expect(connectionFields["edges"]).toBeDefined()
    expect(connectionFields["pageInfo"]).toBeDefined()
    expect(connectionFields["totalEntries"]).toBeDefined()

    // Edge type should have node and cursor
    const edgeType = schema.getType("WarrantyAgentStatsEdge") as any
    expect(edgeType).toBeDefined()
    const edgeFields = edgeType.getFields()
    expect(edgeFields["node"]).toBeDefined()
    expect(edgeFields["cursor"]).toBeDefined()
  })

  it("should add relay connection arguments to .connection_type resolver fields", () => {
    const typeDefs = [
      parseRubyTypeDefinition(AGENT_STATS_TYPE_FIXTURE, "agent_stats.rb")!,
    ]
    const resolvers = [
      parseResolverDefinition(
        AGENT_STATS_CONNECTION_QUERY_FIXTURE,
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
    const field = schema.getQueryType()!.getFields()["agentStats"]
    const argNames = field.args.map((a: any) => a.name)

    // Standard Relay connection args should be present
    expect(argNames).toContain("first")
    expect(argNames).toContain("last")
    expect(argNames).toContain("before")
    expect(argNames).toContain("after")

    // Resolver-specific args should also be present
    expect(argNames).toContain("agentIds")
    expect(argNames).toContain("startDate")
    expect(argNames).toContain("endDate")
  })

  it("should register a built-in PageInfo type with standard Relay fields", () => {
    const typeDefs = [
      parseRubyTypeDefinition(AGENT_STATS_TYPE_FIXTURE, "agent_stats.rb")!,
    ]
    const resolvers = [
      parseResolverDefinition(
        AGENT_STATS_CONNECTION_QUERY_FIXTURE,
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
    const pageInfoType = schema.getType("PageInfo") as any
    expect(pageInfoType).toBeDefined()
    const fields = pageInfoType.getFields()
    expect(fields["hasNextPage"]).toBeDefined()
    expect(fields["hasPreviousPage"]).toBeDefined()
    expect(fields["startCursor"]).toBeDefined()
    expect(fields["endCursor"]).toBeDefined()
  })

  it("should not add relay args to scalar-returning resolver fields", () => {
    const typeDefs = [
      parseRubyTypeDefinition(AGENT_STATS_TYPE_FIXTURE, "agent_stats.rb")!,
    ]
    const fixture = `
module Warranty
  module Graphql
    class CountQuery < NitroGraphql::BaseQuery
      type Integer, null: false
      argument :filter, String, required: false
      def resolve(filter: nil); end
    end
  end
end
`
    const resolvers = [parseResolverDefinition(fixture, "count_query.rb")!]
    const registrations: ResolverRegistration[] = [
      {
        fieldName: "count",
        resolverClassName: "Warranty::Graphql::CountQuery",
        target: "query",
      },
    ]
    const schema = buildGraphQLSchema(typeDefs, resolvers, registrations)
    const field = schema.getQueryType()!.getFields()["count"]
    const argNames = field.args.map((a: any) => a.name)
    expect(argNames).not.toContain("first")
    expect(argNames).not.toContain("after")
    expect(argNames).toContain("filter")
  })

  it("should wrap .connection_type resolver in a Relay Connection type", () => {
    const typeDefs = [
      parseRubyTypeDefinition(
        TIME_OFF_BALANCE_TYPE_FIXTURE,
        "time_off_balance_type.rb"
      )!,
    ]
    const resolvers = [
      parseResolverDefinition(
        TIME_OFF_BALANCE_CONNECTION_QUERY_FIXTURE,
        "time_off_balance_query.rb"
      )!,
    ]
    const registrations: ResolverRegistration[] = [
      {
        fieldName: "timeOffBalance",
        resolverClassName: "Attendance::Graphql::TimeOffBalanceQuery",
        target: "query",
      },
    ]

    const schema = buildGraphQLSchema(typeDefs, resolvers, registrations)
    const field = schema.getQueryType()!.getFields()["timeOffBalance"]

    // Return type should be a Connection, not a plain object
    expect(field.type.toString()).toContain("Connection")

    const connectionType = schema.getType("TimeOffBalanceConnection") as any
    expect(connectionType).toBeDefined()
    const connectionFields = connectionType.getFields()
    expect(connectionFields["nodes"]).toBeDefined()
    expect(connectionFields["pageInfo"]).toBeDefined()

    // relay args should be present
    const argNames = field.args.map((a: any) => a.name)
    expect(argNames).toContain("first")
    expect(argNames).toContain("after")
  })

  it("should store resolver class and access in field extensions", () => {
    const typeDefs = [
      parseRubyTypeDefinition(AGENT_STATS_TYPE_FIXTURE, "agent_stats.rb")!,
    ]
    const resolvers = [
      parseResolverDefinition(
        AGENT_STATS_QUERY_FIXTURE,
        "/abs/path/agent_stats_query.rb"
      )!,
    ]
    const registrations: ResolverRegistration[] = [
      {
        fieldName: "agentStats",
        resolverClassName: "Warranty::Graphql::AgentStatsQuery",
        target: "query",
        access: ["private"],
      },
    ]

    const schema = buildGraphQLSchema(typeDefs, resolvers, registrations)
    const field = schema.getQueryType()!.getFields()["agentStats"]
    const ext = field.extensions as any
    expect(ext.resolverClass).toBe("Warranty::Graphql::AgentStatsQuery")
    expect(ext.resolverFile).toBe("/abs/path/agent_stats_query.rb")
    expect(ext.access).toEqual(["private"])
  })

  it("should resolve PaginationType fields as non-scalar object type", () => {
    const typeDefs = [
      parseRubyTypeDefinition(PAGINATION_TYPE_FIXTURE, "pagination_type.rb")!,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query.rb")!,
    ]
    const schema = buildGraphQLSchema(typeDefs)
    // PaginationType class → deriveTypeName strips "Type" → registered as "Pagination"
    const paginationType = schema.getType("Pagination")
    expect(paginationType).toBeDefined()
    const fields = (paginationType as any).getFields()
    expect(fields["currentPage"]).toBeDefined()
    expect(fields["totalPages"]).toBeDefined()
    expect(fields["totalEntries"]).toBeDefined()
  })

  it("should use graphql_name alias when resolving PhoneNumberType", () => {
    const typeDefs = [
      parseRubyTypeDefinition(
        PHONE_NUMBER_TYPE_FIXTURE,
        "phone_number_type.rb"
      )!,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query.rb")!,
    ]
    const schema = buildGraphQLSchema(typeDefs)
    // PhoneNumberType has graphql_name "PhoneNumber", so it should be accessible as "PhoneNumber"
    const phoneType = schema.getType("PhoneNumber")
    expect(phoneType).toBeDefined()
    const fields = (phoneType as any).getFields()
    expect(fields["number"]).toBeDefined()
    expect(fields["numberType"]).toBeDefined()
  })

  it("should use graphql_name alias when resolving PhoneNumberType", () => {
    const typeDefs = [
      parseRubyTypeDefinition(
        PHONE_NUMBER_TYPE_FIXTURE,
        "phone_number_type.rb"
      )!,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query.rb")!,
    ]
    const schema = buildGraphQLSchema(typeDefs)
    // PhoneNumberType has graphql_name "PhoneNumber", so it should be accessible as "PhoneNumber"
    const phoneType = schema.getType("PhoneNumber")
    expect(phoneType).toBeDefined()
    const fields = (phoneType as any).getFields()
    expect(fields["number"]).toBeDefined()
    expect(fields["numberType"]).toBeDefined()
  })

  it("should NOT redirect type lookup through aliasMap when the name is itself a canonical graphql_name", () => {
    // EmployeeType (Directory) has graphql_name "Employee".
    // EmployeeType (EmployeeReviews) inherits from it with graphql_name "ReviewEmployee".
    // Both have classBasedName "Employee", so aliasMap["Employee"] = "ReviewEmployee".
    // A resolver that returns ::Directory::Graphql::EmployeeType normalizes to "Employee",
    // which must resolve to the real Employee type — NOT ReviewEmployee.
    const directoryEmployeeType = parseRubyTypeDefinition(
      `
module Directory
  module Graphql
    class EmployeeType < NitroGraphql::Types::BaseObject
      graphql_name "Employee"
      field :id, ID, null: false
      field :goes_by_with_last_name, String, null: false
    end
  end
end
`,
      "directory/employee_type.rb"
    )!

    const reviewEmployeeType = parseRubyTypeDefinition(
      `
module EmployeeReviews
  module Graphql
    class EmployeeType < ::Directory::Graphql::EmployeeType
      graphql_name "ReviewEmployee"
      description "An employee in the context of a review."
    end
  end
end
`,
      "employee_reviews/employee_type.rb"
    )!

    const userQueryResolver = parseResolverDefinition(
      `
module UserProfile
  module Graphql
    class UserQuery < NitroGraphql::BaseQuery
      type ::Directory::Graphql::EmployeeType, null: false
      argument :id, Integer, required: false
      def resolve(id:); end
    end
  end
end
`,
      "user_profile/user_query.rb"
    )!

    const registrations: ResolverRegistration[] = [
      {
        fieldName: "user",
        resolverClassName: "::UserProfile::Graphql::UserQuery",
        target: "query",
      },
    ]

    const schema = buildGraphQLSchema(
      [directoryEmployeeType, reviewEmployeeType],
      [userQueryResolver],
      registrations
    )

    const queryType = schema.getQueryType()!
    const userField = queryType.getFields()["user"]
    expect(userField).toBeDefined()

    // The return type must be Employee, not ReviewEmployee
    const returnTypeName =
      (userField.type as any).name ?? (userField.type as any).ofType?.name
    expect(returnTypeName).toBe("Employee")

    // The Employee type must have goesByWithLastName
    const employeeType = schema.getType("Employee") as any
    expect(employeeType).toBeDefined()
    expect(employeeType.getFields()["goesByWithLastName"]).toBeDefined()

    // ReviewEmployee must still exist as a separate type
    const reviewType = schema.getType("ReviewEmployee")
    expect(reviewType).toBeDefined()
  })

  it("should resolve input type with graphql_name override when referenced in mutation arguments", () => {
    // This test specifically covers the case where two namespaces define classes
    // with the same Ruby class name but different graphql_names.  Without rubyPath
    // disambiguation, BrandHeadlines' CalendarEventType would resolve to Spaces'
    // CalendarEvent type (since "CalendarEvent" is already in the registry first).
    const typeDefs = [
      // Spaces types with shorter graphql_names are registered first (simulating
      // the production scenario where they'd win the normalizeRubyType lookup)
      parseRubyTypeDefinition(
        SPACES_CALENDAR_EVENT_TYPE_FIXTURE,
        "spaces/calendar_event_type.rb"
      )!,
      parseRubyTypeDefinition(
        SPACES_CALENDAR_EVENT_INPUT_FIXTURE,
        "spaces/calendar_event_input.rb"
      )!,
      // BrandHeadlines types with the fully-qualified ::BrandHeadlines::Graphql:: refs
      parseRubyTypeDefinition(
        CALENDAR_EVENT_TYPE_FIXTURE,
        "brand_headlines/calendar_event_type.rb"
      )!,
      parseRubyTypeDefinition(
        CALENDAR_EVENT_INPUT_FIXTURE,
        "brand_headlines/calendar_event_input.rb"
      )!,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query_type.rb")!,
    ]
    const resolvers = [
      parseResolverDefinition(
        CREATE_OR_UPDATE_CALENDAR_EVENT_MUTATION_FIXTURE,
        "brand_headlines/create_or_update_calendar_event_mutation.rb"
      )!,
    ]
    const registrations: ResolverRegistration[] = [
      {
        fieldName: "createOrUpdateCalendarEvent",
        resolverClassName:
          "BrandHeadlines::Graphql::CreateOrUpdateCalendarEventMutation",
        target: "mutation",
      },
    ]

    const schema = buildGraphQLSchema(typeDefs, resolvers, registrations)
    const mutationType = schema.getMutationType()!
    const field = mutationType.getFields()["createOrUpdateCalendarEvent"]

    expect(field).toBeDefined()

    // Return type must be exactly BrandHeadlinesCalendarEvent!, NOT CalendarEvent! (Spaces)
    expect(field.type.toString()).toBe("BrandHeadlinesCalendarEvent!")

    // The input argument should resolve to BrandHeadlinesCalendarEventInput, NOT CalendarEventInput (Spaces)
    const inputArg = field.args.find(a => a.name === "input")
    expect(inputArg).toBeDefined()
    expect(inputArg!.type.toString()).toContain(
      "BrandHeadlinesCalendarEventInput"
    )

    // The output type should exist with correct BrandHeadlines fields
    const outputType = schema.getType("BrandHeadlinesCalendarEvent") as any
    expect(outputType).toBeDefined()
    const outputFields = outputType.getFields()
    expect(outputFields["title"]).toBeDefined()
    expect(outputFields["location"]).toBeDefined()
    expect(outputFields["startDate"]).toBeDefined()
    // Spaces' field (summary) must NOT appear on BrandHeadlines' type
    expect(outputFields["summary"]).toBeUndefined()

    // The input type should exist with correct BrandHeadlines fields
    const inputType = schema.getType("BrandHeadlinesCalendarEventInput") as any
    expect(inputType).toBeDefined()
    const inputFields = inputType.getFields()
    expect(inputFields["title"]).toBeDefined()
    expect(inputFields["location"]).toBeDefined()
    // Spaces' field (description) must NOT appear on BrandHeadlines' input
    expect(inputFields["description"]).toBeUndefined()

    // Spaces types must still exist independently with their own fields
    const spacesOutputType = schema.getType("CalendarEvent") as any
    expect(spacesOutputType).toBeDefined()
    const spacesOutputFields = spacesOutputType.getFields()
    expect(spacesOutputFields["summary"]).toBeDefined()

    const spacesInputType = schema.getType("CalendarEventInput") as any
    expect(spacesInputType).toBeDefined()
    const spacesInputFields = spacesInputType.getFields()
    expect(spacesInputFields["description"]).toBeDefined()
  })

  it("should inherit fields from parent type", () => {
    const typeDefs = [
      parseRubyTypeDefinition(
        PROJECT_TASK_TYPE_FIXTURE,
        "project_task_type.rb"
      )!,
      parseRubyTypeDefinition(
        SERVICE_TASK_TYPE_FIXTURE,
        "service_task_type.rb"
      )!,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query.rb")!,
    ]
    const schema = buildGraphQLSchema(typeDefs)
    // ServiceTaskType inherits from ProjectTaskType
    const serviceTaskType = schema.getType("WarantyServiceTask")
    expect(serviceTaskType).toBeDefined()
    const fields = (serviceTaskType as any).getFields()
    // Own fields
    expect(fields["warehouse"]).toBeDefined()
    expect(fields["pulseEnabledHomeownerIds"]).toBeDefined()
    // Inherited from ProjectTaskType
    expect(fields["id"]).toBeDefined()
    expect(fields["scheduledDate"]).toBeDefined()
    expect(fields["project"]).toBeDefined()
    expect(fields["inspectionAppointment"]).toBeDefined()
  })

  it("should build input type inheriting from another InputType", () => {
    const typeDefs = [
      parseRubyTypeDefinition(
        POINT_OF_INTEREST_INPUT_TYPE_FIXTURE,
        "poi_input.rb"
      )!,
      parseRubyTypeDefinition(
        TERRITORY_ZONE_INPUT_TYPE_FIXTURE,
        "zone_input.rb"
      )!,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query.rb")!,
    ]
    // Should build schema without throwing "must be Input Type" error
    expect(() => buildGraphQLSchema(typeDefs)).not.toThrow()
    const schema = buildGraphQLSchema(typeDefs)
    const zoneInput = schema.getType("TerritoryExpansionCollectionZoneInput")
    expect(zoneInput).toBeDefined()
    const fields = (zoneInput as any).getFields()
    // Own arguments
    expect(fields["id"]).toBeDefined()
    expect(fields["color"]).toBeDefined()
    // Inherited from PointOfInterestInputType
    expect(fields["name"]).toBeDefined()
    expect(fields["latitude"]).toBeDefined()
    expect(fields["longitude"]).toBeDefined()
  })

  it("should register module-based interface and resolve field types that reference it", () => {
    const typeDefs = [
      parseRubyTypeDefinition(MODULE_INTERFACE_FIXTURE, "item_interface.rb")!,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query.rb")!,
    ]
    expect(() => buildGraphQLSchema(typeDefs)).not.toThrow()
    const schema = buildGraphQLSchema(typeDefs)
    // Registered under the full module name (Interface suffix kept by deriveTypeName)
    const ifaceType = schema.getType("ServiceQuoteItemItemInterface")
    expect(ifaceType).toBeDefined()
    // Its fields should be accessible (id, model, product)
    const fields = (ifaceType as any).getFields()
    expect(fields["id"]).toBeDefined()
    expect(fields["model"]).toBeDefined()
    expect(fields["product"]).toBeDefined()
  })

  it("should parse a union type (BaseUnion) with possible_types", () => {
    const def = parseRubyTypeDefinition(
      `
module Warranty
  module Graphql
    class ItemableType < NitroGraphql::Types::BaseUnion
      graphql_name "WarrantyItemableType"
      possible_types ServiceQuoteItemType, ServiceQuoteNonItemType
    end
  end
end
`,
      "itemable_type.rb"
    )
    expect(def).not.toBeNull()
    expect(def!.kind).toBe("union")
    expect(def!.name).toBe("WarrantyItemableType")
    expect(def!.possibleTypes).toEqual([
      "ServiceQuoteItem",
      "ServiceQuoteNonItem",
    ])
  })

  it("should parse a union type with parenthesised multiline possible_types", () => {
    const def = parseRubyTypeDefinition(
      `
module Warranty
  module Graphql
    class ItemableType < NitroGraphql::Types::BaseUnion
      graphql_name "WarrantyItemableType"
      possible_types(
        ::Warranty::Graphql::ServiceQuoteItemType,
        ::Warranty::Graphql::ServiceQuoteNonItemType
      )
    end
  end
end
`,
      "itemable_type.rb"
    )
    expect(def).not.toBeNull()
    expect(def!.kind).toBe("union")
    expect(def!.possibleTypes).toEqual([
      "ServiceQuoteItem",
      "ServiceQuoteNonItem",
    ])
  })

  it("should build a union type in the schema and allow inline fragment spreads", () => {
    const serviceQuoteItemType = parseRubyTypeDefinition(
      `
module Warranty
  module Graphql
    class ServiceQuoteItemType < NitroGraphql::Types::BaseObject
      graphql_name "ServiceQuoteItemType"
      field :id, ID, null: false
      field :item_charge, Float
    end
  end
end
`,
      "service_quote_item_type.rb"
    )!

    const serviceQuoteNonItemType = parseRubyTypeDefinition(
      `
module Warranty
  module Graphql
    class ServiceQuoteNonItemType < NitroGraphql::Types::BaseObject
      graphql_name "ServiceQuoteNonItemType"
      field :id, ID, null: false
      field :name, String
    end
  end
end
`,
      "service_quote_non_item_type.rb"
    )!

    const itemableUnion = parseRubyTypeDefinition(
      `
module Warranty
  module Graphql
    class ItemableType < NitroGraphql::Types::BaseUnion
      graphql_name "WarrantyItemableType"
      possible_types ServiceQuoteItemType, ServiceQuoteNonItemType
    end
  end
end
`,
      "itemable_type.rb"
    )!

    expect(itemableUnion.kind).toBe("union")
    expect(itemableUnion.possibleTypes).toEqual([
      "ServiceQuoteItem",
      "ServiceQuoteNonItem",
    ])

    const typeDefs = [
      serviceQuoteItemType,
      serviceQuoteNonItemType,
      itemableUnion,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query.rb")!,
    ]
    expect(() => buildGraphQLSchema(typeDefs)).not.toThrow()
    const schema = buildGraphQLSchema(typeDefs)

    // Union type itself should be in the schema
    const unionType = schema.getType("WarrantyItemableType")
    expect(unionType).toBeDefined()
    expect(unionType).toBeInstanceOf(require("graphql").GraphQLUnionType)

    // The member types should be accessible
    const memberNames = (unionType as any).getTypes().map((t: any) => t.name)
    expect(memberNames).toContain("ServiceQuoteItemType")
    expect(memberNames).toContain("ServiceQuoteNonItemType")
  })

  it("should parse inline field arguments from do...end blocks on interface fields", () => {
    const def = parseRubyTypeDefinition(
      `
module Warranty
  module Graphql
    module ServiceQuoteItemItemInterface
      include NitroGraphql::Types::BaseInterface

      field :id, ID, null: false
      field :media_items, [String], access: %i[private customer] do
        argument :document_type_code, [String], required: false
      end
    end
  end
end
`,
      "service_quote_item_item_interface.rb"
    )!

    expect(def.kind).toBe("interface")
    const mediaField = def.fields.find(f => f.name === "mediaItems")
    expect(mediaField).toBeDefined()
    expect(mediaField!.fieldArgs).toBeDefined()
    expect(mediaField!.fieldArgs!.length).toBe(1)
    expect(mediaField!.fieldArgs![0].name).toBe("documentTypeCode")
    expect(mediaField!.fieldArgs![0].isList).toBe(true)
    expect(mediaField!.fieldArgs![0].required).toBe(false)
  })

  it("should include field args in built interface type so queries can use them", () => {
    const ifaceTypeDef = parseRubyTypeDefinition(
      `
module Warranty
  module Graphql
    module ServiceQuoteItemItemInterface
      include NitroGraphql::Types::BaseInterface

      field :id, ID, null: false
      field :media_items, [String], access: %i[private customer] do
        argument :document_type_code, [String], required: false
      end
    end
  end
end
`,
      "service_quote_item_item_interface.rb"
    )!

    const typeDefs = [
      ifaceTypeDef,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query.rb")!,
    ]
    expect(() => buildGraphQLSchema(typeDefs)).not.toThrow()
    const schema = buildGraphQLSchema(typeDefs)

    const ifaceType = schema.getType("ServiceQuoteItemItemInterface") as any
    expect(ifaceType).toBeDefined()
    const mediaItemsField = ifaceType.getFields()["mediaItems"]
    expect(mediaItemsField).toBeDefined()
    // The field must expose the documentTypeCode argument
    const argNames = mediaItemsField.args.map((a: any) => a.name)
    expect(argNames).toContain("documentTypeCode")
  })

  it("should resolve field type via typeRubyPath when two types share the same classBasedName", () => {
    // Reproduces the EquipmentAsset collision:
    //   EquipmentAssets::Graphql::EquipmentAssetType  → graphql_name "EquipmentAsset"
    //   Directory::Graphql::EquipmentAssetType        → graphql_name "equipment_asset"
    // Both normalise to "EquipmentAsset" via normalizeRubyType.  Without
    // typeRubyPath tracking the field would pick up the wrong (simpler) type.
    const typeDefs = [
      // Register the simpler type first so it pre-occupies the "EquipmentAsset" name
      parseRubyTypeDefinition(
        EQUIPMENT_ASSETS_EQUIPMENT_ASSET_TYPE_FIXTURE,
        "equipment_assets/equipment_asset_type.rb"
      )!,
      parseRubyTypeDefinition(
        DIRECTORY_EQUIPMENT_ASSET_TYPE_FIXTURE,
        "directory/equipment_asset_type.rb"
      )!,
      parseRubyTypeDefinition(
        EMPLOYEE_WITH_EQUIPMENT_TYPE_FIXTURE,
        "directory/employee_type.rb"
      )!,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query_type.rb")!,
    ]
    const schema = buildGraphQLSchema(typeDefs)

    const employeeType = schema.getType("Employee") as any
    expect(employeeType).toBeDefined()
    const empFields = employeeType.getFields()

    // The field must exist and resolve to "equipment_asset" (Directory's version)
    const equipField = empFields["equipmentAssets"]
    expect(equipField).toBeDefined()

    // Unwrap list/non-null wrappers to get the base named type
    let elementType: any = equipField.type
    while (elementType.ofType) elementType = elementType.ofType
    expect(elementType.name).toBe("equipment_asset")

    // Directory's "equipment_asset" type must have the richer fields
    const assetType = schema.getType("equipment_asset") as any
    expect(assetType).toBeDefined()
    const assetFields = assetType.getFields()
    expect(assetFields["serialNumber"]).toBeDefined()
    expect(assetFields["status"]).toBeDefined()

    // The simpler "EquipmentAsset" type must still exist but lacks serialNumber
    const simpleType = schema.getType("EquipmentAsset") as any
    expect(simpleType).toBeDefined()
    expect(simpleType.getFields()["serialNumber"]).toBeUndefined()
  })

  it("should wire return type and arguments for field: resolver: Class fields", () => {
    // Reproduces the SupportTicketDomain.paginatedTickets scenario:
    //   field :paginated_tickets, resolver: ::Support::Graphql::PaginatedTicketsQuery
    // Without this fix the field gets type _Unknown_PaginatedTicketsQuery and no args.
    const typeDefs = [
      parseRubyTypeDefinition(
        SUPPORT_PAGINATED_RESULT_TYPE_FIXTURE,
        "support/paginated_tickets_result_type.rb"
      )!,
      parseRubyTypeDefinition(
        SUPPORT_TICKET_TYPE_FIXTURE,
        "support/ticket_type.rb"
      )!,
      parseRubyTypeDefinition(
        SUPPORT_DOMAIN_TYPE_FIXTURE,
        "support/domain_type.rb"
      )!,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query_type.rb")!,
    ]
    const resolvers = [
      parseResolverDefinition(
        PAGINATED_TICKETS_QUERY_FIXTURE,
        "support/paginated_tickets_query.rb"
      )!,
    ]
    const schema = buildGraphQLSchema(typeDefs, resolvers)

    const domainType = schema.getType("SupportTicketDomain") as any
    expect(domainType).toBeDefined()
    const domainFields = domainType.getFields()

    const paginatedField = domainFields["paginatedTickets"]
    expect(paginatedField).toBeDefined()

    // Return type must be PaginatedTicketsResult (from the resolver declaration)
    let returnType: any = paginatedField.type
    while (returnType.ofType) returnType = returnType.ofType
    expect(returnType.name).toBe("PaginatedTicketsResult")

    // Arguments from PaginatedTicketsQuery must be exposed on the field
    const argNames: string[] = paginatedField.args.map((a: any) => a.name)
    expect(argNames).toContain("search")
    expect(argNames).toContain("page")
    expect(argNames).toContain("perPage")

    // PaginatedTicketsResult type must have its own fields
    const resultType = schema.getType("PaginatedTicketsResult") as any
    expect(resultType).toBeDefined()
    const resultFields = resultType.getFields()
    expect(resultFields["totalCount"]).toBeDefined()
    expect(resultFields["tickets"]).toBeDefined()
  })

  it("should respect camelize: false on field declarations", () => {
    // When a field declares camelize: false, its name should not be camelCased.
    // Example: field :new_appts_plan, String, camelize: false → "new_appts_plan" (not "newApptsPlan")
    const typeDefs = [
      parseRubyTypeDefinition(
        APPOINTMENT_TYPE_FIXTURE,
        "scheduling/appointment_type.rb"
      )!,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query_type.rb")!,
    ]
    const schema = buildGraphQLSchema(typeDefs)

    const appointmentType = schema.getType("Appointment") as any
    expect(appointmentType).toBeDefined()
    const appointmentFields = appointmentType.getFields()

    // Fields with camelize: false should keep their snake_case names
    expect(appointmentFields["new_appts_plan"]).toBeDefined()
    expect(appointmentFields["status_code"]).toBeDefined()

    // Fields without camelize: false should be camelCased
    expect(appointmentFields["visitTime"]).toBeDefined()

    // The incorrectly camelCased versions should NOT exist
    expect(appointmentFields["newApptsPlan"]).toBeUndefined()
    expect(appointmentFields["statusCode"]).toBeUndefined()
  })

  it("should handle array types with inline options in field declarations", () => {
    // When a field uses array syntax with inline options like [Type, { null: true }],
    // the parser should correctly extract just the type name, not include the options.
    // Example: field :phone_numbers, [PhoneNumberType, { null: true }], null: false
    // Should resolve type as PhoneNumber, not as _Unknown_PhoneNumberType____null__true__
    const typeDefs = [
      parseRubyTypeDefinition(
        PHONE_NUMBERS_TYPE_FIXTURE,
        "core/phone_number_type.rb"
      )!,
      parseRubyTypeDefinition(
        EMPLOYEE_WITH_PHONE_NUMBERS_FIXTURE,
        "core/employee_type.rb"
      )!,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query_type.rb")!,
    ]
    const schema = buildGraphQLSchema(typeDefs)

    const employeeType = schema.getType("Employee") as any
    expect(employeeType).toBeDefined()
    const employeeFields = employeeType.getFields()

    // Field should exist
    const phoneNumbersField = employeeFields["phoneNumbers"]
    expect(phoneNumbersField).toBeDefined()

    // Unwrap list and non-null wrappers to get base type
    let elementType: any = phoneNumbersField.type
    while (elementType.ofType) {
      elementType = elementType.ofType
    }

    // Base type should be PhoneNumber, not some unknown mangled type
    expect(elementType.name).toBe("PhoneNumber")

    // PhoneNumber type must be properly resolved with its fields
    const phoneNumberType = schema.getType("PhoneNumber") as any
    expect(phoneNumberType).toBeDefined()
    const phoneNumberFields = phoneNumberType.getFields()
    expect(phoneNumberFields["extension"]).toBeDefined()
    expect(phoneNumberFields["number"]).toBeDefined()
  })

  it("should handle field with do...end block for inline arguments", () => {
    // A field can open a `do...end` block to declare inline arguments:
    //   field :pay_period_summary, Craftsman::Graphql::CraftsmanPayPeriodSummaryType do
    //     argument :date, NitroGraphql::Types::Date, required: false
    //   end
    // The ` do` suffix must not corrupt the type name, and the argument must be wired up.
    const payPeriodSummaryType = parseRubyTypeDefinition(
      `
module Craftsman
  module Graphql
    class CraftsmanPayPeriodSummaryType < NitroGraphql::Types::BaseObject
      graphql_name "CraftsmanPayPeriodSummary"
      description "A craftsman pay period summary"

      field :id, ID, null: false
      field :total_pay, Float, null: false
    end
  end
end
`,
      "craftsman/craftsman_pay_period_summary_type.rb"
    )!

    const craftsmanType = parseRubyTypeDefinition(
      `
module Craftsman
  module Graphql
    class CraftsmanType < NitroGraphql::Types::BaseObject
      graphql_name "Craftsman"
      description "A craftsman"

      field :id, ID, null: false
      field :pay_period_summary, Craftsman::Graphql::CraftsmanPayPeriodSummaryType do
        argument :date, String, required: false
      end
    end
  end
end
`,
      "craftsman/craftsman_type.rb"
    )!

    const typeDefs = [
      payPeriodSummaryType,
      craftsmanType,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query_type.rb")!,
    ]
    const schema = buildGraphQLSchema(typeDefs)

    const craftsmanGqlType = schema.getType("Craftsman") as any
    expect(craftsmanGqlType).toBeDefined()
    const fields = craftsmanGqlType.getFields()

    // Field must exist and resolve to CraftsmanPayPeriodSummary, not unknown
    const field = fields["payPeriodSummary"]
    expect(field).toBeDefined()

    let elementType: any = field.type
    while (elementType.ofType) elementType = elementType.ofType
    expect(elementType.name).toBe("CraftsmanPayPeriodSummary")

    // The inline argument `date` must be wired up on the field
    const dateArg = field.args?.find((a: any) => a.name === "date")
    expect(dateArg).toBeDefined()

    // CraftsmanPayPeriodSummary must have its own fields
    const summaryType = schema.getType("CraftsmanPayPeriodSummary") as any
    expect(summaryType).toBeDefined()
    const summaryFields = summaryType.getFields()
    expect(summaryFields["id"]).toBeDefined()
    expect(summaryFields["totalPay"]).toBeDefined()
  })
})

describe("resolver namespace collision", () => {
  it("should pick the correct resolver when two namespaces define the same class name", () => {
    // Reproduces the real case:
    //   field :pending_proposed_warranty_item_changes,
    //         resolver: ::Warranty::Graphql::PendingProposedItemChangesQuery
    //
    // Two components both have a resolver named PendingProposedItemChangesQuery
    // but in different namespaces with different arguments.  The field name has
    // "warranty" in it but the class name does not — make sure that does not
    // confuse the matching and that the explicit resolver: path wins.

    const warrantyResolver = parseResolverDefinition(
      `
module Warranty
  module Graphql
    class PendingProposedItemChangesQuery < NitroGraphql::BaseQuery
      type [::Warranty::Graphql::ProposedItemChangeType], null: true

      argument :service_quote_id, ID

      def resolve(service_quote_id:)
      end
    end
  end
end
`,
      "warranty/pending_proposed_item_changes_query.rb"
    )!

    const projectsResolver = parseResolverDefinition(
      `
module Projects
  module Graphql
    class PendingProposedItemChangesQuery < NitroGraphql::BaseQuery
      type [String], null: true

      argument :project_id, ID
      argument :product_id, ID

      def resolve(project_id:, product_id:)
      end
    end
  end
end
`,
      "projects/pending_proposed_item_changes_query.rb"
    )!

    expect(warrantyResolver.className).toBe(
      "Warranty::Graphql::PendingProposedItemChangesQuery"
    )
    expect(projectsResolver.className).toBe(
      "Projects::Graphql::PendingProposedItemChangesQuery"
    )

    const proposedItemChangeType = parseRubyTypeDefinition(
      `
module Warranty
  module Graphql
    class ProposedItemChangeType < NitroGraphql::Types::BaseObject
      field :id, ID, null: false
    end
  end
end
`,
      "proposed_item_change_type.rb"
    )!

    const registrations: ResolverRegistration[] = [
      {
        fieldName: "pendingProposedWarrantyItemChanges",
        resolverClassName:
          "::Warranty::Graphql::PendingProposedItemChangesQuery",
        target: "query",
      },
    ]

    // Pass both resolvers — Projects resolver must NOT win
    const schema = buildGraphQLSchema(
      [proposedItemChangeType],
      [warrantyResolver, projectsResolver],
      registrations
    )

    const queryType = schema.getQueryType()!
    const field = queryType.getFields()["pendingProposedWarrantyItemChanges"]
    expect(field).toBeDefined()

    const argNames = field.args.map(a => a.name)
    // Must have serviceQuoteId from the Warranty resolver
    expect(argNames).toContain("serviceQuoteId")
    // Must NOT have projectId / productId from the Projects resolver
    expect(argNames).not.toContain("projectId")
    expect(argNames).not.toContain("productId")
  })

  it("should also pick correct resolver when Projects resolver is inserted first in map order", () => {
    const warrantyResolver = parseResolverDefinition(
      `
module Warranty
  module Graphql
    class PendingProposedItemChangesQuery < NitroGraphql::BaseQuery
      type [String], null: true
      argument :service_quote_id, ID
      def resolve(service_quote_id:); end
    end
  end
end
`,
      "warranty/pending_proposed_item_changes_query.rb"
    )!

    const projectsResolver = parseResolverDefinition(
      `
module Projects
  module Graphql
    class PendingProposedItemChangesQuery < NitroGraphql::BaseQuery
      type [String], null: true
      argument :project_id, ID
      argument :product_id, ID
      def resolve(project_id:, product_id:); end
    end
  end
end
`,
      "projects/pending_proposed_item_changes_query.rb"
    )!

    const registrations: ResolverRegistration[] = [
      {
        fieldName: "pendingProposedWarrantyItemChanges",
        // leading :: is stripped during matching
        resolverClassName:
          "::Warranty::Graphql::PendingProposedItemChangesQuery",
        target: "query",
      },
    ]

    // Projects resolver passed first — must still resolve to Warranty
    const schema = buildGraphQLSchema(
      [],
      [projectsResolver, warrantyResolver],
      registrations
    )

    const queryType = schema.getQueryType()!
    const field = queryType.getFields()["pendingProposedWarrantyItemChanges"]
    expect(field).toBeDefined()

    const argNames = field.args.map(a => a.name)
    expect(argNames).toContain("serviceQuoteId")
    expect(argNames).not.toContain("projectId")
    expect(argNames).not.toContain("productId")
  })

  it("should prefer same-namespace type over identically-named type in different namespace", () => {
    // Reproduces: Craftsman::Graphql::MarkCraftsmanAvailableMutation declares
    //   type ActivityType, null: false
    // Ruby resolves unqualified names by looking in the enclosing namespace first.
    // Craftsman::Graphql::ActivityType must win over Projects::Graphql::ActivityType.

    const craftsmanActivityType = parseRubyTypeDefinition(
      `
module Craftsman
  module Graphql
    class ActivityType < NitroGraphql::Types::BaseObject
      graphql_name "CraftsmanActivity"
      field :id, ID, null: false
      field :status, String
    end
  end
end
`,
      "craftsman/graphql/activity_type.rb"
    )!

    const projectsActivityType = parseRubyTypeDefinition(
      `
module Projects
  module Graphql
    class ActivityType < NitroGraphql::Types::BaseObject
      field :icon, String, null: false
      field :color, String, null: false
    end
  end
end
`,
      "projects/graphql/activity_type.rb"
    )!

    const craftsmanMutation = parseResolverDefinition(
      `
module Craftsman
  module Graphql
    class MarkCraftsmanAvailableMutation < NitroGraphql::BaseQuery
      type ActivityType, null: false
      argument :activity_id, ID
      def resolve(activity_id:); end
    end
  end
end
`,
      "craftsman/graphql/mark_craftsman_available_mutation.rb"
    )!

    // returnTypeRubyPath must be set to the namespace-qualified candidate
    expect(craftsmanMutation.returnTypeRubyPath).toBe(
      "Craftsman::Graphql::ActivityType"
    )

    const registrations: ResolverRegistration[] = [
      {
        fieldName: "markCraftsmanAvailable",
        resolverClassName: "Craftsman::Graphql::MarkCraftsmanAvailableMutation",
        target: "mutation",
      },
    ]

    const schema = buildGraphQLSchema(
      [
        craftsmanActivityType,
        projectsActivityType,
        parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query_type.rb")!,
      ],
      [craftsmanMutation],
      registrations
    )

    const mutationType = schema.getMutationType()!
    const field = mutationType.getFields()["markCraftsmanAvailable"]
    expect(field).toBeDefined()

    // Unwrap NonNull to get the base type
    let baseType: any = field.type
    while (baseType.ofType) baseType = baseType.ofType

    // Must resolve to CraftsmanActivity, not Activity (Projects one)
    expect(baseType.name).toBe("CraftsmanActivity")
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

  it("should find types directories under lib/ paths", () => {
    // Create: components/nitro_graphql/lib/nitro_graphql/types/
    const typesDir = path.join(
      tmpDir,
      "components",
      "nitro_graphql",
      "lib",
      "nitro_graphql",
      "types"
    )
    fs.mkdirSync(typesDir, { recursive: true })

    const dirs = findGraphQLDirectories(tmpDir)
    expect(dirs.some(d => d.endsWith("types"))).toBe(true)
  })

  it("should not include types directories outside lib/ paths", () => {
    // Create: components/foo/app/types/ (no lib/ in path)
    const typesDir = path.join(tmpDir, "components", "foo", "app", "types")
    fs.mkdirSync(typesDir, { recursive: true })

    const dirs = findGraphQLDirectories(tmpDir)
    // Should not pick up this types dir (not under lib/)
    expect(dirs.some(d => d.includes("app/types"))).toBe(false)
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
    expect(resolver.isConnectionType).toBe(false)
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
    expect(resolver.isConnectionType).toBe(false)

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

  it("should parse .connection_type syntax and set isConnectionType flag", () => {
    const resolver = parseResolverDefinition(
      TIME_OFF_BALANCE_CONNECTION_QUERY_FIXTURE,
      "time_off_balance_query.rb"
    )!
    expect(resolver).not.toBeNull()
    expect(resolver.returnType).toBe("TimeOffBalance")
    expect(resolver.returnTypeIsList).toBe(false)
    expect(resolver.isConnectionType).toBe(true)
    expect(resolver.returnTypeNullable).toBe(false)
    expect(resolver.arguments.length).toBe(2)
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

  it("should parse multi-line argument definitions", () => {
    const content = `argument :with_exclude_from_directory,
               Boolean,
               required: false,
               default_value: false,
               description: "Set to true if you want excludeFromDirectory in your results."
argument :search, NitroGraphql::Types::Json, required: false
argument :through, String, required: false`
    const args = parseArguments(content)
    expect(args.length).toBe(3)

    // First arg is multi-line with default_value
    expect(args[0].name).toBe("withExcludeFromDirectory")
    expect(args[0].type).toBe("Boolean")
    expect(args[0].required).toBe(false)
    expect(args[0].defaultValue).toBe("false")

    // Second arg: optional
    expect(args[1].name).toBe("search")
    expect(args[1].required).toBe(false)

    // Third arg: optional
    expect(args[2].name).toBe("through")
    expect(args[2].required).toBe(false)
  })

  it("should parse argument named 'type' without consuming the return type declaration", () => {
    const content = `argument :type, String

type ::ContactCenter::Graphql::CallLoopStatusType, null: false

def resolve(type:)`
    const args = parseArguments(content)
    expect(args.length).toBe(1)
    expect(args[0].name).toBe("type")
    expect(args[0].type).toBe("String")
    expect(args[0].required).toBe(true)
  })
})

describe("parseRegistrationFile", () => {
  it("should parse queries and mutations from registration file", () => {
    const registrations = parseRegistrationFile(REGISTRATION_FILE_FIXTURE)
    expect(registrations.length).toBe(7)

    const queries = registrations.filter(r => r.target === "query")
    expect(queries.length).toBe(4)

    const mutations = registrations.filter(r => r.target === "mutation")
    expect(mutations.length).toBe(3)
  })

  it("should parse field when access: appears before resolver:", () => {
    const registrations = parseRegistrationFile(REGISTRATION_FILE_FIXTURE)
    const field = registrations.find(
      r => r.fieldName === "accessBeforeResolver"
    )
    expect(field).toBeDefined()
    expect(field!.resolverClassName).toContain("AgentStatsQuery")
    expect(field!.target).toBe("query")
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

  it("should parse simple symbol access level from registration field", () => {
    const content = `
module Foo
  module Graphql
    extend ::NitroGraphql::Schema::Partial

    mutations do
      field :create_thing,
            resolver: ::Foo::Graphql::CreateThingMutation,
            access: :private
    end
  end
end
`
    const registrations = parseRegistrationFile(content)
    expect(registrations.length).toBe(1)
    expect(registrations[0].access).toEqual(["private"])
  })

  it("should parse :public access level from registration field", () => {
    const content = `
module Foo
  module Graphql
    extend ::NitroGraphql::Schema::Partial

    queries do
      field :my_query,
            resolver: ::Foo::Graphql::MyQuery,
            access: :public
    end
  end
end
`
    const registrations = parseRegistrationFile(content)
    expect(registrations[0].access).toEqual(["public"])
  })

  it("should parse access when it appears before resolver:", () => {
    const registrations = parseRegistrationFile(REGISTRATION_FILE_FIXTURE)
    const field = registrations.find(
      r => r.fieldName === "accessBeforeResolver"
    )
    expect(field).toBeDefined()
    expect(field!.access).toEqual(["public"])
  })

  it("should default access to private when access uses complex hash form", () => {
    // Complex permission hashes like { Project => :create } fall back to private
    const registrations = parseRegistrationFile(REGISTRATION_FILE_FIXTURE)
    const field = registrations.find(r => r.fieldName === "createServiceOrder")
    expect(field).toBeDefined()
    expect(field!.access).toEqual(["private"])
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

// ── Mixin Argument Parsing ─────────────────────────────────────────────────────

describe("parseMixinArguments", () => {
  const PAGINATION_MIXIN = `
module NitroGraphql
  module PaginationArguments
    def self.included(cls)
      cls.class_eval do
        argument :page, Integer, required: false, description: "Current page", default_value: 1
        argument :per_page, Integer,
                 required: false,
                 description: "Number of results per page",
                 default_value: 100 do
                   validates numericality: { greater_than: 0, less_than_or_equal_to: 100 }
                 end
      end
    end
  end
end
`

  it("should parse arguments from a self.included mixin module", () => {
    const result = parseMixinArguments(PAGINATION_MIXIN)
    expect(result).not.toBeNull()
    expect(result!.modulePath).toBe("NitroGraphql::PaginationArguments")
    expect(result!.arguments).toHaveLength(2)

    const names = result!.arguments.map(a => a.name)
    expect(names).toContain("page")
    expect(names).toContain("perPage")
  })

  it("should return null for a file without self.included", () => {
    const result = parseMixinArguments(`
module Foo
  module Bar
    def some_method
    end
  end
end
`)
    expect(result).toBeNull()
  })

  it("should return null for a file with self.included but no arguments", () => {
    const result = parseMixinArguments(`
module Foo
  module Bar
    def self.included(cls)
      cls.class_eval do
        # just a comment, no arguments
      end
    end
  end
end
`)
    expect(result).toBeNull()
  })
})

describe("parseMixinRegistry", () => {
  it("should build a registry from a map of file contents", () => {
    const files = new Map<string, string>([
      [
        "pagination_arguments.rb",
        `
module NitroGraphql
  module PaginationArguments
    def self.included(cls)
      cls.class_eval do
        argument :page, Integer, required: false, default_value: 1
        argument :per_page, Integer, required: false, default_value: 100
      end
    end
  end
end
`,
      ],
      ["unrelated.rb", "class Foo < Bar; end"],
    ])

    const registry = parseMixinRegistry(files)
    expect(registry.size).toBe(1)
    expect(registry.has("NitroGraphql::PaginationArguments")).toBe(true)

    const args = registry.get("NitroGraphql::PaginationArguments")!
    expect(args.map(a => a.name)).toEqual(["page", "perPage"])
  })
})

describe("parseResolverDefinition with mixin arguments", () => {
  const PAGINATION_MIXIN_ARGS = [
    {
      name: "page",
      type: "Int",
      required: false,
      isList: false,
      defaultValue: "1",
    },
    {
      name: "perPage",
      type: "Int",
      required: false,
      isList: false,
      defaultValue: "100",
    },
  ]

  it("should merge arguments from included mixin modules", () => {
    const mixinRegistry = new Map([
      ["NitroGraphql::PaginationArguments", PAGINATION_MIXIN_ARGS],
    ])

    const resolver = parseResolverDefinition(
      `
module Directory
  module Graphql
    class CommonPassphrasesQuery < NitroGraphql::BaseQuery
      include NitroGraphql::PaginationArguments

      description "Library of common passphrases in Nitro."

      type ::Directory::Graphql::CommonPassphraseResults, null: false

      def resolve(per_page:, page:)
      end
    end
  end
end
`,
      "directory/common_passphrases_query.rb",
      mixinRegistry
    )

    expect(resolver).not.toBeNull()

    const argNames = resolver!.arguments.map(a => a.name)
    expect(argNames).toContain("page")
    expect(argNames).toContain("perPage")
  })

  it("should not duplicate arguments already declared on the resolver", () => {
    const mixinRegistry = new Map([
      ["NitroGraphql::PaginationArguments", PAGINATION_MIXIN_ARGS],
    ])

    const resolver = parseResolverDefinition(
      `
module Foo
  module Graphql
    class MyQuery < NitroGraphql::BaseQuery
      include NitroGraphql::PaginationArguments

      type String, null: false

      argument :page, Integer, required: false, default_value: 2

      def resolve(page:, per_page:); end
    end
  end
end
`,
      "foo/my_query.rb",
      mixinRegistry
    )

    expect(resolver).not.toBeNull()
    const argNames = resolver!.arguments.map(a => a.name)
    // page declared on resolver itself — should appear only once
    expect(argNames.filter(n => n === "page")).toHaveLength(1)
    // perPage comes from mixin
    expect(argNames).toContain("perPage")
  })

  it("should surface mixin arguments in the built schema", () => {
    const paginationMixin = `
module NitroGraphql
  module PaginationArguments
    def self.included(cls)
      cls.class_eval do
        argument :page, Integer, required: false, default_value: 1
        argument :per_page, Integer, required: false, default_value: 100
      end
    end
  end
end
`
    const mixinRegistry = parseMixinRegistry(
      new Map([["pagination_arguments.rb", paginationMixin]])
    )

    const resultsType = parseRubyTypeDefinition(
      `
module Directory
  module Graphql
    class CommonPassphraseResults < NitroGraphql::Types::BaseObject
      graphql_name "CommonPassphraseResults"
      field :list, [String]
      field :page, Int
      field :per_page, Int
    end
  end
end
`,
      "directory/common_passphrase_results.rb"
    )!

    const resolver = parseResolverDefinition(
      `
module Directory
  module Graphql
    class CommonPassphrasesQuery < NitroGraphql::BaseQuery
      include NitroGraphql::PaginationArguments

      type ::Directory::Graphql::CommonPassphraseResults, null: false

      def resolve(per_page:, page:); end
    end
  end
end
`,
      "directory/common_passphrases_query.rb",
      mixinRegistry
    )!

    const registrations: ResolverRegistration[] = [
      {
        fieldName: "commonPassphrases",
        resolverClassName: "Directory::Graphql::CommonPassphrasesQuery",
        target: "query",
      },
    ]

    const schema = buildGraphQLSchema([resultsType], [resolver], registrations)

    const queryType = schema.getQueryType()!
    const field = queryType.getFields()["commonPassphrases"]
    expect(field).toBeDefined()

    const argNames = field.args.map((a: any) => a.name)
    expect(argNames).toContain("page")
    expect(argNames).toContain("perPage")
  })
})
