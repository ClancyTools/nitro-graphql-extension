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
  loadMixinFiles,
  buildGraphQLSchema,
  validateSchemaIntegrity,
  buildSchemaFromDirectory,
  snakeToCamel,
  parseMixinArguments,
  parseMixinRegistry,
  detectDynamicFieldBlocks,
  resolveDynamicFields,
  GraphQLTypeDefinition,
  ResolverDefinition,
  ResolverRegistration,
} from "../src/schema/rubySchemaBuilder"

// ── Fixtures ───────────────────────────────────────────────────────────────────

const COURSE_TYPE_FIXTURE = `
# frozen_string_literal: true

module CircusAcademy
  module Graphql
    class ActType < CircusApp::Types::BaseObject
      implements ::Crowd::Graphql::CrowdInterface

      graphql_name "CircusAcademyAct"
      description "An act in the Circus Academy"

      field :id, ID, null: false
      field :title, String
      field :description, String
      field :show_assessment_answers, Boolean, null: false
      field :predecessor_id, Integer
      field :revisions, [::CircusAcademy::Graphql::ActRevisionType], null: false
      field :current_revision, ::CircusAcademy::Graphql::ActRevisionType, null: false
      field :playbills, [::CircusAcademy::Graphql::PlaybillType]
      field :tag_list, [String], null: false
      field :track_time, Boolean, null: false

      belongs_to :instructor, ::BigTop::Graphql::PerformerType, null: false
      belongs_to :category, ::CircusAcademy::Graphql::GenreType
      has_one :certificate, ::CircusAcademy::Graphql::AwardType
      has_one :featured_review, ::CircusAcademy::Graphql::CritiqueType, null: false
      has_many :enrollments, [::CircusAcademy::Graphql::TicketType]
      has_many :act_tags, [::CircusAcademy::Graphql::ActTagType], null: false
    end
  end
end
`

const ACCESS_TYPE_FIXTURE = `
module BigTop
  module Graphql
    class PerformerType < CircusApp::Types::BaseObject
      graphql_name "Performer"

      field :name, String, null: false, access: :public
      field :id, ID, null: false, access: %i[private customer]
      field :email, String, access: :partner
      field :wages, Float
      field :troupe, String, null: false, access: [:private, :admin]
    end
  end
end
`

const QUERY_TYPE_FIXTURE = `
module CircusApp
  class QueryType < CircusApp::Types::BaseObject
    graphql_name "Queries"

    field :performer, ::BigTop::Graphql::PerformerType, null: true
    field :act, ::CircusAcademy::Graphql::ActType, null: true
    field :tents, [::Midway::Graphql::TentType], null: false
  end
end
`

const MUTATION_TYPE_FIXTURE = `
module CircusApp
  class MutationType < CircusApp::Types::BaseObject
    graphql_name "Mutations"

    field :update_performer, ::BigTop::Graphql::PerformerType, null: true
  end
end
`

const ENUM_TYPE_FIXTURE = `
module Midway
  module Graphql
    class StatusEnum < CircusApp::Types::BaseEnum
      graphql_name "StatusEnum"

      value "ACTIVE"
      value "INACTIVE"
      value "PENDING"
    end
  end
end
`

const INPUT_TYPE_FIXTURE = `
module BigTop
  module Graphql
    class PerformerInputType < CircusApp::Types::BaseInputObject
      graphql_name "PerformerInput"

      argument :name, String, required: true
      field :email, String
    end
  end
end
`

const INTERFACE_TYPE_FIXTURE = `
module Crowd
  module Graphql
    class CrowdInterface < CircusApp::Types::BaseInterface
      graphql_name "CrowdInterface"

      field :id, ID, null: false
      field :name, String
    end
  end
end
`

const COUNTRY_TYPE_FIXTURE = `
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

const EMPTY_FIELDS_TYPE = `
module Broken
  module Graphql
    class EmptyType < CircusApp::Types::BaseObject
      graphql_name "BrokenEmpty"
    end
  end
end
`

// ── Query/Mutation Resolver Fixtures ──────────────────────────────────────────

const AGENT_STATS_QUERY_FIXTURE = `
module HighWire
  module Graphql
    class ClownStatsQuery < CircusApp::BaseQuery
      description "Get a list of high wire clowns using the provided IDs"

      type [::HighWire::Graphql::ClownStatsType], null: false

      argument :clown_ids, [ID]
      argument :start_date, String, required: false
      argument :end_date, String, required: false

      def resolve(clown_ids:, start_date: nil, end_date: nil)
      end
    end
  end
end
`

const AGENT_STATS_CONNECTION_QUERY_FIXTURE = `
module HighWire
  module Graphql
    class ClownStatsQuery < CircusApp::BaseQuery
      description "Get a list of high wire clowns using the provided IDs"

      type ::HighWire::Graphql::ClownStatsType.connection_type, null: false

      argument :clown_ids, [ID]
      argument :start_date, String, required: false
      argument :end_date, String, required: false

      def resolve(clown_ids:, start_date: nil, end_date: nil)
      end
    end
  end
end
`

const AVAILABLE_ROUTES_QUERY_FIXTURE = `
module HighWire
  module Graphql
    class ShowRoutesQuery < ::CircusApp::BaseQuery
      description "Get available routes for a specific date"

      type [::CircusCore::Graphql::CircusRouteType], null: false
      argument :date_range, [CircusApp::Types::Date]
      argument :territory_id, ID
      argument :route_group, String, required: false, default_value: "service"

      def resolve(date_range:, territory_id:, route_group: "service")
      end
    end
  end
end
`

const COUNT_INCOMING_CALLS_QUERY_FIXTURE = `
module HighWire
  module Graphql
    class CountGuestArrivalsQuery < ::CircusApp::BaseQuery
      description "Get count of guest arrivals for the evening"

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
module HighWire
  module Graphql
    class BookShowEquipmentMutation < CircusApp::BaseQuery
      description "Book a show equipment order"

      type [::CircusCore::Graphql::PropOrderType], null: false

      argument :show_id, ID
      argument :seat_number, String, required: false
      argument :items, [HighWire::Graphql::ShowOrderItemInputType]

      def resolve(show_id:, items:, seat_number: nil)
      end
    end
  end
end
`

const CANCEL_SERVICE_APPOINTMENT_MUTATION_FIXTURE = `
module HighWire
  module Graphql
    class CancelShowBookingMutation < CircusApp::BaseQuery
      description "Cancel a show booking"

      type ::CircusCore::Graphql::ShowTaskType, null: false

      argument :show_quote_id, ID
      argument :attributes, ::HighWire::Graphql::ShowBookingInputType

      def resolve(show_quote_id:, attributes:)
      end
    end
  end
end
`

const DELETE_ADDITIONAL_SERVICE_MUTATION_FIXTURE = `
module HighWire
  module Graphql
    class RemoveExtraActMutation < CircusApp::BaseQuery
      description "Remove an extra act from a show booking"

      type ::HighWire::Graphql::ShowBookingExtraType, null: false

      argument :id, ID

      def resolve(id:)
      end
    end
  end
end
`

const TIME_OFF_BALANCE_TYPE_FIXTURE = `
module CrewRoll
  module Graphql
    class BreakCreditType < CircusApp::Types::BaseObject
      field :hours, Float
      field :credit_type, String
    end
  end
end
`

const TIME_OFF_BALANCE_CONNECTION_QUERY_FIXTURE = `
module CrewRoll
  module Graphql
    class BreakCreditQuery < CircusApp::BaseQuery
      description "Returns break credit hours"

      type ::CrewRoll::Graphql::BreakCreditType.connection_type, null: false
      argument :bucket, String
      argument :search, CircusApp::Types::Json, required: false

      def resolve(bucket:, search: {})
      end
    end
  end
end
`

const SERVICE_APPOINTMENT_INPUT_TYPE_FIXTURE = `
module HighWire
  module Graphql
    class ShowBookingInputType < CircusApp::Types::BaseInputObject
      graphql_name "ShowBookingInput"

      argument :show_task_id, ID
      argument :cant_perform_reason, String, required: false
      argument :notes, String, required: false
    end
  end
end
`

const CALENDAR_EVENT_TYPE_FIXTURE = `
module Marquee
  module Graphql
    class ShowEventType < ::CircusApp::Types::BaseObject
      graphql_name "MarqueeShowEvent"

      field :id, ID, null: false
      field :title, String
      field :location, String
      field :start_date, CircusApp::Types::DateTime
      field :end_date, CircusApp::Types::DateTime
      field :details, String
    end
  end
end
`

const CALENDAR_EVENT_INPUT_FIXTURE = `
module Marquee
  module Graphql
    class ShowEventInput < CircusApp::Types::BaseInputObject
      graphql_name "MarqueeShowEventInput"

      argument :id, ID, required: false
      argument :title, String
      argument :location, String
      argument :start_date, CircusApp::Types::DateTime
      argument :end_date, CircusApp::Types::DateTime
      argument :details, String, required: false
    end
  end
end
`

// A conflicting type in a different namespace with the same class name
const SPACES_CALENDAR_EVENT_TYPE_FIXTURE = `
module TentSpace
  module Graphql
    class ShowEventType < CircusApp::Types::BaseObject
      graphql_name "TentShowEvent"

      field :id, ID, null: false
      field :summary, String, null: false
      field :event_start, GraphQL::Types::ISO8601DateTime, null: false
    end
  end
end
`

// A conflicting input type in a different namespace with the same class name
const SPACES_CALENDAR_EVENT_INPUT_FIXTURE = `
module TentSpace
  module Graphql
    class ShowEventInput < CircusApp::Types::BaseInputObject
      graphql_name "TentShowEventInput"

      argument :summary, String
      argument :description, String, required: false
    end
  end
end
`

const CREATE_OR_UPDATE_CALENDAR_EVENT_MUTATION_FIXTURE = `
module Marquee
  module Graphql
    class CreateOrUpdateShowEventMutation < CircusApp::BaseQuery
      description "Creates or updates a show event"

      type ::Marquee::Graphql::ShowEventType, null: false
      argument :input, ::Marquee::Graphql::ShowEventInput

      def resolve(input:)
        input_hash = input.to_h
        if input_hash[:id].present?
          show_event = ::Marquee::ShowEvent.find(input_hash.delete(:id))
          show_event.update!(input_hash)
          show_event
        else
          ::Marquee::ShowEvent.create!(input_hash)
        end
      end
    end
  end
end
`

// ── PropAsset disambiguation fixtures ─────────────────────────────────────────

// BigTop's richer version (graphql_name differs from normalized classBasedName)
const DIRECTORY_EQUIPMENT_ASSET_TYPE_FIXTURE = `
module BigTop
  module Graphql
    class PropAssetType < CircusApp::Types::BaseObject
      graphql_name "prop_item"
      description "A prop assigned to a performer"

      field :id, ID, null: false
      field :prop_number, String, null: false
      field :prop_serial, String
      field :status, String
    end
  end
end
`

// A separate, simpler type in a different namespace with the same class name
const EQUIPMENT_ASSETS_EQUIPMENT_ASSET_TYPE_FIXTURE = `
module PropHouse
  module Graphql
    class PropAssetType < CircusApp::Types::BaseObject
      graphql_name "PropAsset"
      description "Prop asset info"

      field :id, ID, null: false
      field :category, String
      field :prop_number, String, null: false
    end
  end
end
`

// Performer type referencing BigTop's version via fully-qualified path
const EMPLOYEE_WITH_EQUIPMENT_TYPE_FIXTURE = `
module BigTop
  module Graphql
    class PerformerType < CircusApp::Types::BaseObject
      graphql_name "Performer"

      field :id, ID, null: false
      field :name, String, null: false
      field :prop_assets, [::BigTop::Graphql::PropAssetType]
    end
  end
end
`

// ── Nested resolver field fixtures ─────────────────────────────────────────────

const SUPPORT_PAGINATED_RESULT_TYPE_FIXTURE = `
module Backstage
  module Graphql
    class ShowSeatsResultType < CircusApp::Types::BaseObject
      graphql_name "ShowSeatsResult"

      field :total_count, Int, null: false
      field :seats, [::Backstage::Graphql::SeatType]
    end
  end
end
`

const SUPPORT_TICKET_TYPE_FIXTURE = `
module Backstage
  module Graphql
    class SeatType < CircusApp::Types::BaseObject
      graphql_name "BackstageSeat"

      field :id, ID, null: false
      field :seat_number, String, null: false
    end
  end
end
`

const PAGINATED_TICKETS_QUERY_FIXTURE = `
module Backstage
  module Graphql
    class ShowSeatsQuery < CircusApp::BaseQuery
      description "Returns paginated show seats"

      type ::Backstage::Graphql::ShowSeatsResultType, null: false
      argument :search, CircusApp::Types::Json, required: false
      argument :page, Int
      argument :per_page, Int

      def resolve(search: nil, page: 1, per_page: 10)
        # implementation
      end
    end
  end
end
`

// BigTopType with a field backed by a resolver class
const SUPPORT_DOMAIN_TYPE_FIXTURE = `
module Backstage
  module Graphql
    class StageHubType < CircusApp::Types::BaseObject
      graphql_name "BackstageHub"

      field :id, ID, null: false
      field :name, String, null: false
      field :show_seats, resolver: ::Backstage::Graphql::ShowSeatsQuery
    end
  end
end
`

// Test fixture for camelize: false option
const APPOINTMENT_TYPE_FIXTURE = `
module ShowSchedule
  module Graphql
    class ShowSlotType < CircusApp::Types::BaseObject
      graphql_name "ShowSlot"
      description "A scheduled show slot"

      field :id, ID, null: false
      field :title, String, null: false
      # This field should NOT be camelCased because of camelize: false
      field :new_acts_plan, String, camelize: false
      # This field should be camelCased normally
      field :show_time, String, null: false
      field :status_code, String, camelize: false
    end
  end
end
`

// Test fixture for array types with inline options
const PHONE_NUMBERS_TYPE_FIXTURE = `
module BigTop
  module Graphql
    class RingToneType < CircusApp::Types::BaseObject
      graphql_name "RingTone"
      description "A ring tone"

      field :extension, String
      field :number, String, null: false
    end
  end
end
`

// Type with a field using array syntax with inline options
const EMPLOYEE_WITH_PHONE_NUMBERS_FIXTURE = `
module BigTop
  module Graphql
    class PerformerType < CircusApp::Types::BaseObject
      graphql_name "Performer"

      field :id, ID, null: false
      field :name, String, null: false
      # This is the pattern that was breaking: [Type, { null: true }]
      # The parser should extract just "RingToneType" and ignore the inline options
      field :ring_tones, [CircusApp::PropRegistry::RingToneType, { null: true }], null: false
    end
  end
end
`

const AGENT_STATS_TYPE_FIXTURE = `
module HighWire
  module Graphql
    class ClownStatsType < CircusApp::Types::BaseObject
      graphql_name "HighWireClownStats"

      field :crowd_count, Int
      field :avg_crowd, Float
      field :idle_duration, Float
    end
  end
end
`

const REGISTRATION_FILE_FIXTURE = `
module HighWire
  module Graphql
    extend ::CircusApp::Schema::Partial

    queries do
      field :troupe_stats,
            resolver: ::HighWire::Graphql::ClownStatsQuery,
            access: { high_wire_stats_board: :view }

      field :show_routes,
            resolver: ::HighWire::Graphql::ShowRoutesQuery,
            access: { ShowSlot => :update }

      field :count_guest_arrivals,
            resolver: ::HighWire::Graphql::CountGuestArrivalsQuery,
            access: { ::RingServices::GuestEntry => :take }

      field :access_before_resolver,
            access: :public,
            resolver: ::HighWire::Graphql::ClownStatsQuery
    end

    mutations do
      field :book_show_equipment,
            resolver: ::HighWire::Graphql::BookShowEquipmentMutation,
            access: { Show => :create_prop_order }

      field :cancel_show_booking,
            resolver: ::HighWire::Graphql::CancelShowBookingMutation,
            access: { ShowTask => :show_work_queue }

      field :remove_extra_act,
            resolver: ::HighWire::Graphql::RemoveExtraActMutation,
            access: { ShowTask => :show_work_queue }
    end
  end
end
`

const PROPOSED_SERVICE_CHANGE_STATUS_ENUM_FIXTURE = `
module HighWire
  module Graphql
    class ActRevisionStatusEnum < CircusApp::Types::BaseEnum
      value "proposed"
      value "canceled"
      value "submitted"
    end
  end
end
`

const PAGINATION_TYPE_FIXTURE = `
module CircusApp
  module Types
    class PaginationType < CircusApp::Types::BaseObject
      field :current_page, Integer, null: false
      field :total_pages, Integer, null: false
      field :total_entries, Integer, null: false
    end
  end
end
`

const PHONE_NUMBER_TYPE_FIXTURE = `
module CircusApp
  module PropRegistry
    class RingToneType < CircusApp::Types::BaseObject
      graphql_name "RingTone"
      field :id, ID, null: false
      field :number, String, null: false
      field :number_type, String, null: false
    end
  end
end
`

const PROJECT_TASK_TYPE_FIXTURE = `
module CircusCore
  module Graphql
    class ShowTaskType < CircusApp::Types::BaseObject
      graphql_name "ShowTask"

      field :id, ID, null: false
      field :scheduled_date, String
      field :require_safety_check, Boolean, null: false
      belongs_to :show, ::CircusCore::Graphql::ShowType
      belongs_to :prop, ::CircusCore::Graphql::PropType
      belongs_to :show_slot, ::CircusCore::Graphql::ShowSlotType
    end
  end
end
`

const SERVICE_TASK_TYPE_FIXTURE = `
module HighWire
  module Graphql
    class RigTaskType < CircusCore::Graphql::ShowTaskType
      graphql_name "HighWireRigTask"

      field :storage_tent, String
      field :vip_holder_ids, [ID]
      field :active_show_quote, HighWire::Graphql::ShowQuoteType
    end
  end
end
`

const POINT_OF_INTEREST_INPUT_TYPE_FIXTURE = `
module CircusMaps
  module Graphql
    class RingMarkerInputType < CircusApp::Types::BaseInputObject
      graphql_name "RingMarkerInput"

      argument :name, String, required: false
      argument :latitude, Float, required: true
      argument :longitude, Float, required: true
    end
  end
end
`

const TERRITORY_ZONE_INPUT_TYPE_FIXTURE = `
module CircusMaps
  module Graphql
    class CircusTerritoryZoneInputType < ::CircusMaps::Graphql::RingMarkerInputType
      graphql_name "CircusTerritoryZoneInput"

      argument :id, ID, required: false
      argument :section_name, String, required: false
      argument :color, String, required: false
    end
  end
end
`

const MODULE_INTERFACE_FIXTURE = `
module HighWire
  module Graphql
    module ShowItemInterface
      include CircusApp::Types::BaseInterface

      field :id, ID, null: false
      field :model, String
      field :color, String
      field :serial_number, String

      belongs_to :prop, ::CircusCore::Graphql::PropType, null: false
    end
  end
end
`

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("parseRubyTypeDefinition", () => {
  it("should parse a standard object type with graphql_name", () => {
    const def = parseRubyTypeDefinition(COURSE_TYPE_FIXTURE, "course_type.rb")
    expect(def).not.toBeNull()
    expect(def!.name).toBe("CircusAcademyAct")
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
    const versionsField = def.fields.find(f => f.name === "revisions")
    expect(versionsField).toBeDefined()
    expect(versionsField!.isList).toBe(true)
    expect(versionsField!.nullable).toBe(false)
  })

  it("should extract implements clauses", () => {
    const def = parseRubyTypeDefinition(COURSE_TYPE_FIXTURE, "course_type.rb")!
    expect(def.implements).toContain("CrowdInterface")
  })

  it("should parse a type with access levels", () => {
    const def = parseRubyTypeDefinition(
      ACCESS_TYPE_FIXTURE,
      "performer_type.rb"
    )!
    expect(def.name).toBe("Performer")

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
      "performer_type.rb"
    )!
    const wagesField = def.fields.find(f => f.name === "wages")
    expect(wagesField!.access).toEqual(["private"])
  })

  it("should parse enum types", () => {
    const def = parseRubyTypeDefinition(ENUM_TYPE_FIXTURE, "status_enum.rb")!
    expect(def.kind).toBe("enum")
    expect(def.enumValues).toEqual(["ACTIVE", "INACTIVE", "PENDING"])
  })

  it("should parse interface types", () => {
    const def = parseRubyTypeDefinition(
      INTERFACE_TYPE_FIXTURE,
      "crowd_interface.rb"
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
    const performerField = def.fields.find(f => f.name === "performer")
    expect(performerField!.type).toBe("Performer")
  })

  it("should map Integer to Int", () => {
    const def = parseRubyTypeDefinition(COURSE_TYPE_FIXTURE, "course_type.rb")!
    const prereqField = def.fields.find(f => f.name === "predecessorId")
    expect(prereqField!.type).toBe("Int")
  })

  it("should parse belongs_to as a non-list field in camelCase", () => {
    const def = parseRubyTypeDefinition(COURSE_TYPE_FIXTURE, "course_type.rb")!
    const instructorField = def.fields.find(f => f.name === "instructor")
    expect(instructorField).toBeDefined()
    expect(instructorField!.type).toBe("Performer")
    expect(instructorField!.isList).toBe(false)
    expect(instructorField!.nullable).toBe(false)

    const categoryField = def.fields.find(f => f.name === "category")
    expect(categoryField).toBeDefined()
    expect(categoryField!.type).toBe("Genre")
    expect(categoryField!.isList).toBe(false)
    expect(categoryField!.nullable).toBe(true)
  })

  it("should parse has_one as a non-list field in camelCase", () => {
    const def = parseRubyTypeDefinition(COURSE_TYPE_FIXTURE, "course_type.rb")!
    const certField = def.fields.find(f => f.name === "certificate")
    expect(certField).toBeDefined()
    expect(certField!.type).toBe("Award")
    expect(certField!.isList).toBe(false)
    expect(certField!.nullable).toBe(true)

    const reviewField = def.fields.find(f => f.name === "featuredReview")
    expect(reviewField).toBeDefined()
    expect(reviewField!.type).toBe("Critique")
    expect(reviewField!.isList).toBe(false)
    expect(reviewField!.nullable).toBe(false)
  })

  it("should parse has_many as a list field in camelCase", () => {
    const def = parseRubyTypeDefinition(COURSE_TYPE_FIXTURE, "course_type.rb")!
    const enrollmentsField = def.fields.find(f => f.name === "enrollments")
    expect(enrollmentsField).toBeDefined()
    expect(enrollmentsField!.type).toBe("Ticket")
    expect(enrollmentsField!.isList).toBe(true)

    const actTagsField = def.fields.find(f => f.name === "actTags")
    expect(actTagsField).toBeDefined()
    expect(actTagsField!.type).toBe("ActTag")
    expect(actTagsField!.isList).toBe(true)
  })

  it("should parse type that inherits from a custom Type class", () => {
    const def = parseRubyTypeDefinition(
      SERVICE_TASK_TYPE_FIXTURE,
      "rig_task_type.rb"
    )
    expect(def).not.toBeNull()
    expect(def!.kind).toBe("object")
    expect(def!.name).toBe("HighWireRigTask")
    // Own fields should be present
    const storageTentField = def!.fields.find(f => f.name === "storageTent")
    expect(storageTentField).toBeDefined()
  })

  it("should parse InputType inheritance as kind input", () => {
    const def = parseRubyTypeDefinition(
      TERRITORY_ZONE_INPUT_TYPE_FIXTURE,
      "circus_territory_zone_input_type.rb"
    )
    expect(def).not.toBeNull()
    expect(def!.kind).toBe("input")
    expect(def!.name).toBe("CircusTerritoryZoneInput")
  })

  it("should parse argument declarations on input type as fields", () => {
    const def = parseRubyTypeDefinition(
      POINT_OF_INTEREST_INPUT_TYPE_FIXTURE,
      "ring_marker_input_type.rb"
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
      "show_item_interface.rb"
    )
    expect(def).not.toBeNull()
    expect(def!.kind).toBe("interface")
    // deriveTypeName does not strip "Interface" suffix, only "Type"
    expect(def!.name).toBe("ShowItemInterface")
    // Should have parsed its fields
    const idField = def!.fields.find(f => f.name === "id")
    expect(idField).toBeDefined()
    const propField = def!.fields.find(f => f.name === "prop")
    expect(propField).toBeDefined()
    expect(propField!.type).toBe("Prop")
  })

  it("should respect camelize: false on field declarations", () => {
    // When a field declares camelize: false, its name should NOT be camelCased
    const def = parseRubyTypeDefinition(
      APPOINTMENT_TYPE_FIXTURE,
      "show_slot_type.rb"
    )
    expect(def).not.toBeNull()

    // Field with camelize: false must keep snake_case
    const newActsField = def!.fields.find(f => f.name === "new_acts_plan")
    expect(newActsField).toBeDefined()
    expect(newActsField!.type).toBe("String")
    expect(newActsField!.camelize).toBe(false)

    const statusCodeField = def!.fields.find(f => f.name === "status_code")
    expect(statusCodeField).toBeDefined()
    expect(statusCodeField!.type).toBe("String")
    expect(statusCodeField!.camelize).toBe(false)

    // Field without camelize: false should be camelCased
    const showTimeField = def!.fields.find(f => f.name === "showTime")
    expect(showTimeField).toBeDefined()
    expect(showTimeField!.type).toBe("String")
    // camelize should be true (or omitted, which defaults to true)
    expect(showTimeField!.camelize).not.toBe(false)

    // Wrong casing should NOT exist
    expect(def!.fields.find(f => f.name === "newActsPlan")).toBeUndefined()
    expect(def!.fields.find(f => f.name === "show_time")).toBeUndefined()
  })

  it("should parse array types with inline options correctly", () => {
    // When an array type includes inline options like [Type, { null: true }],
    // we should extract only the type name, not the options
    const def = parseRubyTypeDefinition(
      EMPLOYEE_WITH_PHONE_NUMBERS_FIXTURE,
      "performer_type.rb"
    )
    expect(def).not.toBeNull()

    const ringTonesField = def!.fields.find(f => f.name === "ringTones")
    expect(ringTonesField).toBeDefined()
    // Type should be "RingTone" (derived from RingToneType after stripping inline options)
    expect(ringTonesField!.type).toBe("RingTone")
    // Should be recognized as a list
    expect(ringTonesField!.isList).toBe(true)
    // Field-level null: false applies to the field itself (not nullable)
    expect(ringTonesField!.nullable).toBe(false)
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
      parseRubyTypeDefinition(COUNTRY_TYPE_FIXTURE, "tent.rb")!,
      parseRubyTypeDefinition(ACCESS_TYPE_FIXTURE, "performer.rb")!,
      parseRubyTypeDefinition(INTERFACE_TYPE_FIXTURE, "crowd.rb")!,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query.rb")!,
      parseRubyTypeDefinition(COURSE_TYPE_FIXTURE, "act.rb")!,
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
    expect(fields["performer"]).toBeDefined()
    expect(fields["act"]).toBeDefined()
    expect(fields["tents"]).toBeDefined()
  })

  it("should resolve type references across types", () => {
    const typeDefs = buildTestSchema()
    const schema = buildGraphQLSchema(typeDefs)
    const performerType = schema.getType("Performer")
    expect(performerType).toBeDefined()
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
    const typeDefs = [parseRubyTypeDefinition(COUNTRY_TYPE_FIXTURE, "tent.rb")!]
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
      parseRubyTypeDefinition(AGENT_STATS_TYPE_FIXTURE, "clown_stats_type.rb")!,
    ]
    const resolvers = [
      parseResolverDefinition(
        AGENT_STATS_QUERY_FIXTURE,
        "clown_stats_query.rb"
      )!,
    ]
    const registrations: ResolverRegistration[] = [
      {
        fieldName: "troupeStats",
        resolverClassName: "HighWire::Graphql::ClownStatsQuery",
        target: "query",
      },
    ]

    const schema = buildGraphQLSchema(typeDefs, resolvers, registrations)
    const queryType = schema.getQueryType()!
    const fields = queryType.getFields()

    expect(fields["troupeStats"]).toBeDefined()
    // Should have arguments from the resolver
    expect(fields["troupeStats"].args.length).toBeGreaterThan(0)
    const clownIdsArg = fields["troupeStats"].args.find(
      a => a.name === "clownIds"
    )
    expect(clownIdsArg).toBeDefined()
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
        "remove_extra_act_mutation.rb"
      )!,
    ]
    const registrations: ResolverRegistration[] = [
      {
        fieldName: "removeExtraAct",
        resolverClassName: "HighWire::Graphql::RemoveExtraActMutation",
        target: "mutation",
      },
    ]

    // Need a query type too
    const queryTypeDefs = [
      ...typeDefs,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query.rb")!,
      parseRubyTypeDefinition(COUNTRY_TYPE_FIXTURE, "tent.rb")!,
      parseRubyTypeDefinition(ACCESS_TYPE_FIXTURE, "performer.rb")!,
      parseRubyTypeDefinition(INTERFACE_TYPE_FIXTURE, "crowd.rb")!,
      parseRubyTypeDefinition(COURSE_TYPE_FIXTURE, "act.rb")!,
    ]

    const schema = buildGraphQLSchema(queryTypeDefs, resolvers, registrations)
    const mutationType = schema.getMutationType()!
    expect(mutationType).toBeDefined()

    const fields = mutationType.getFields()
    expect(fields["removeExtraAct"]).toBeDefined()
    const idArg = fields["removeExtraAct"].args.find(a => a.name === "id")
    expect(idArg).toBeDefined()
  })

  it("should build schema with both resolvers and traditional type defs", () => {
    const typeDefs = [
      parseRubyTypeDefinition(COUNTRY_TYPE_FIXTURE, "tent.rb")!,
      parseRubyTypeDefinition(ACCESS_TYPE_FIXTURE, "performer.rb")!,
      parseRubyTypeDefinition(INTERFACE_TYPE_FIXTURE, "crowd.rb")!,
      parseRubyTypeDefinition(COURSE_TYPE_FIXTURE, "act.rb")!,
      parseRubyTypeDefinition(AGENT_STATS_TYPE_FIXTURE, "clown_stats.rb")!,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query.rb")!,
    ]
    const resolvers = [
      parseResolverDefinition(
        AGENT_STATS_QUERY_FIXTURE,
        "clown_stats_query.rb"
      )!,
    ]
    const registrations: ResolverRegistration[] = [
      {
        fieldName: "troupeStats",
        resolverClassName: "HighWire::Graphql::ClownStatsQuery",
        target: "query",
      },
    ]

    const schema = buildGraphQLSchema(typeDefs, resolvers, registrations)
    const queryType = schema.getQueryType()!
    const fields = queryType.getFields()

    // Should have resolver-registered fields
    expect(fields["troupeStats"]).toBeDefined()
    // Should also have legacy Query type fields
    expect(fields["performer"]).toBeDefined()
    expect(fields["tents"]).toBeDefined()
  })

  it("should handle resolver with scalar return type (Int)", () => {
    const typeDefs = [
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query.rb")!,
      parseRubyTypeDefinition(COUNTRY_TYPE_FIXTURE, "tent.rb")!,
      parseRubyTypeDefinition(ACCESS_TYPE_FIXTURE, "performer.rb")!,
      parseRubyTypeDefinition(INTERFACE_TYPE_FIXTURE, "crowd.rb")!,
      parseRubyTypeDefinition(COURSE_TYPE_FIXTURE, "act.rb")!,
    ]
    const resolvers = [
      parseResolverDefinition(
        COUNT_INCOMING_CALLS_QUERY_FIXTURE,
        "count_guest_arrivals.rb"
      )!,
    ]
    const registrations: ResolverRegistration[] = [
      {
        fieldName: "countGuestArrivals",
        resolverClassName: "HighWire::Graphql::CountGuestArrivalsQuery",
        target: "query",
      },
    ]

    const schema = buildGraphQLSchema(typeDefs, resolvers, registrations)
    const queryType = schema.getQueryType()!
    const fields = queryType.getFields()
    expect(fields["countGuestArrivals"]).toBeDefined()
  })

  it("should handle resolver with list return type", () => {
    const typeDefs = [
      parseRubyTypeDefinition(AGENT_STATS_TYPE_FIXTURE, "clown_stats.rb")!,
    ]
    const resolvers = [
      parseResolverDefinition(
        AGENT_STATS_QUERY_FIXTURE,
        "clown_stats_query.rb"
      )!,
    ]
    const registrations: ResolverRegistration[] = [
      {
        fieldName: "troupeStats",
        resolverClassName: "HighWire::Graphql::ClownStatsQuery",
        target: "query",
      },
    ]

    const schema = buildGraphQLSchema(typeDefs, resolvers, registrations)
    const queryType = schema.getQueryType()!
    const field = queryType.getFields()["troupeStats"]
    // Plain list returns are NOT wrapped in a Connection type
    expect(field.type.toString()).toContain("HighWireClownStats")
    expect(field.type.toString()).not.toContain("Connection")
  })

  it("should wrap .connection_type resolver in a Relay Connection type", () => {
    const typeDefs = [
      parseRubyTypeDefinition(AGENT_STATS_TYPE_FIXTURE, "clown_stats.rb")!,
    ]
    const resolvers = [
      parseResolverDefinition(
        AGENT_STATS_CONNECTION_QUERY_FIXTURE,
        "clown_stats_query.rb"
      )!,
    ]
    const registrations: ResolverRegistration[] = [
      {
        fieldName: "troupeStats",
        resolverClassName: "HighWire::Graphql::ClownStatsQuery",
        target: "query",
      },
    ]

    const schema = buildGraphQLSchema(typeDefs, resolvers, registrations)
    const queryType = schema.getQueryType()!
    const field = queryType.getFields()["troupeStats"]

    // Return type should be a Connection, not a plain list
    expect(field.type.toString()).toContain("Connection")

    // Connection type should have nodes, edges, pageInfo, totalEntries
    const connectionType = schema.getType("HighWireClownStatsConnection") as any
    expect(connectionType).toBeDefined()
    const connectionFields = connectionType.getFields()
    expect(connectionFields["nodes"]).toBeDefined()
    expect(connectionFields["edges"]).toBeDefined()
    expect(connectionFields["pageInfo"]).toBeDefined()
    expect(connectionFields["totalEntries"]).toBeDefined()

    // Edge type should have node and cursor
    const edgeType = schema.getType("HighWireClownStatsEdge") as any
    expect(edgeType).toBeDefined()
    const edgeFields = edgeType.getFields()
    expect(edgeFields["node"]).toBeDefined()
    expect(edgeFields["cursor"]).toBeDefined()
  })

  it("should add relay connection arguments to .connection_type resolver fields", () => {
    const typeDefs = [
      parseRubyTypeDefinition(AGENT_STATS_TYPE_FIXTURE, "clown_stats.rb")!,
    ]
    const resolvers = [
      parseResolverDefinition(
        AGENT_STATS_CONNECTION_QUERY_FIXTURE,
        "clown_stats_query.rb"
      )!,
    ]
    const registrations: ResolverRegistration[] = [
      {
        fieldName: "troupeStats",
        resolverClassName: "HighWire::Graphql::ClownStatsQuery",
        target: "query",
      },
    ]

    const schema = buildGraphQLSchema(typeDefs, resolvers, registrations)
    const field = schema.getQueryType()!.getFields()["troupeStats"]
    const argNames = field.args.map((a: any) => a.name)

    // Standard Relay connection args should be present
    expect(argNames).toContain("first")
    expect(argNames).toContain("last")
    expect(argNames).toContain("before")
    expect(argNames).toContain("after")

    // Resolver-specific args should also be present
    expect(argNames).toContain("clownIds")
    expect(argNames).toContain("startDate")
    expect(argNames).toContain("endDate")
  })

  it("should register a built-in PageInfo type with standard Relay fields", () => {
    const typeDefs = [
      parseRubyTypeDefinition(AGENT_STATS_TYPE_FIXTURE, "clown_stats.rb")!,
    ]
    const resolvers = [
      parseResolverDefinition(
        AGENT_STATS_CONNECTION_QUERY_FIXTURE,
        "clown_stats_query.rb"
      )!,
    ]
    const registrations: ResolverRegistration[] = [
      {
        fieldName: "troupeStats",
        resolverClassName: "HighWire::Graphql::ClownStatsQuery",
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
      parseRubyTypeDefinition(AGENT_STATS_TYPE_FIXTURE, "clown_stats.rb")!,
    ]
    const fixture = `
module HighWire
  module Graphql
    class CountQuery < CircusApp::BaseQuery
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
        resolverClassName: "HighWire::Graphql::CountQuery",
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
        "break_credit_type.rb"
      )!,
    ]
    const resolvers = [
      parseResolverDefinition(
        TIME_OFF_BALANCE_CONNECTION_QUERY_FIXTURE,
        "break_credit_query.rb"
      )!,
    ]
    const registrations: ResolverRegistration[] = [
      {
        fieldName: "breakCredit",
        resolverClassName: "CrewRoll::Graphql::BreakCreditQuery",
        target: "query",
      },
    ]

    const schema = buildGraphQLSchema(typeDefs, resolvers, registrations)
    const field = schema.getQueryType()!.getFields()["breakCredit"]

    // Return type should be a Connection, not a plain object
    expect(field.type.toString()).toContain("Connection")

    const connectionType = schema.getType("BreakCreditConnection") as any
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
      parseRubyTypeDefinition(AGENT_STATS_TYPE_FIXTURE, "clown_stats.rb")!,
    ]
    const resolvers = [
      parseResolverDefinition(
        AGENT_STATS_QUERY_FIXTURE,
        "/abs/path/clown_stats_query.rb"
      )!,
    ]
    const registrations: ResolverRegistration[] = [
      {
        fieldName: "troupeStats",
        resolverClassName: "HighWire::Graphql::ClownStatsQuery",
        target: "query",
        access: ["private"],
      },
    ]

    const schema = buildGraphQLSchema(typeDefs, resolvers, registrations)
    const field = schema.getQueryType()!.getFields()["troupeStats"]
    const ext = field.extensions as any
    expect(ext.resolverClass).toBe("HighWire::Graphql::ClownStatsQuery")
    expect(ext.resolverFile).toBe("/abs/path/clown_stats_query.rb")
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

  it("should use graphql_name alias when resolving RingToneType", () => {
    const typeDefs = [
      parseRubyTypeDefinition(PHONE_NUMBER_TYPE_FIXTURE, "ring_tone_type.rb")!,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query.rb")!,
    ]
    const schema = buildGraphQLSchema(typeDefs)
    // RingToneType has graphql_name "RingTone", so it should be accessible as "RingTone"
    const ringToneType = schema.getType("RingTone")
    expect(ringToneType).toBeDefined()
    const fields = (ringToneType as any).getFields()
    expect(fields["number"]).toBeDefined()
    expect(fields["numberType"]).toBeDefined()
  })

  it("should use graphql_name alias when resolving RingToneType", () => {
    const typeDefs = [
      parseRubyTypeDefinition(PHONE_NUMBER_TYPE_FIXTURE, "ring_tone_type.rb")!,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query.rb")!,
    ]
    const schema = buildGraphQLSchema(typeDefs)
    // RingToneType has graphql_name "RingTone", so it should be accessible as "RingTone"
    const ringToneType = schema.getType("RingTone")
    expect(ringToneType).toBeDefined()
    const fields = (ringToneType as any).getFields()
    expect(fields["number"]).toBeDefined()
    expect(fields["numberType"]).toBeDefined()
  })

  it("should NOT redirect type lookup through aliasMap when the name is itself a canonical graphql_name", () => {
    // BigTop::Graphql::PerformerType has graphql_name "Performer".
    // ArtistReviews::Graphql::PerformerType inherits from it with graphql_name "FeaturedPerformer".
    // Both have classBasedName "Performer", so aliasMap["Performer"] = "FeaturedPerformer".
    // A resolver that returns ::BigTop::Graphql::PerformerType normalizes to "Performer",
    // which must resolve to the real Performer type — NOT FeaturedPerformer.
    const bigTopPerformerType = parseRubyTypeDefinition(
      `
module BigTop
  module Graphql
    class PerformerType < CircusApp::Types::BaseObject
      graphql_name "Performer"
      field :id, ID, null: false
      field :goes_by_stage_name, String, null: false
    end
  end
end
`,
      "big_top/performer_type.rb"
    )!

    const artistReviewsPerformerType = parseRubyTypeDefinition(
      `
module ArtistReviews
  module Graphql
    class PerformerType < ::BigTop::Graphql::PerformerType
      graphql_name "FeaturedPerformer"
      description "A performer in the context of a review."
    end
  end
end
`,
      "artist_reviews/performer_type.rb"
    )!

    const performerQueryResolver = parseResolverDefinition(
      `
module PerformerProfile
  module Graphql
    class PerformerQuery < CircusApp::BaseQuery
      type ::BigTop::Graphql::PerformerType, null: false
      argument :id, Integer, required: false
      def resolve(id:); end
    end
  end
end
`,
      "performer_profile/performer_query.rb"
    )!

    const registrations: ResolverRegistration[] = [
      {
        fieldName: "performer",
        resolverClassName: "::PerformerProfile::Graphql::PerformerQuery",
        target: "query",
      },
    ]

    const schema = buildGraphQLSchema(
      [bigTopPerformerType, artistReviewsPerformerType],
      [performerQueryResolver],
      registrations
    )

    const queryType = schema.getQueryType()!
    const userField = queryType.getFields()["performer"]
    expect(userField).toBeDefined()

    // The return type must be Performer, not FeaturedPerformer
    const returnTypeName =
      (userField.type as any).name ?? (userField.type as any).ofType?.name
    expect(returnTypeName).toBe("Performer")

    // The Performer type must have goesByStageName
    const performerType = schema.getType("Performer") as any
    expect(performerType).toBeDefined()
    expect(performerType.getFields()["goesByStageName"]).toBeDefined()

    // FeaturedPerformer must still exist as a separate type
    const reviewType = schema.getType("FeaturedPerformer")
    expect(reviewType).toBeDefined()
  })

  it("should resolve input type with graphql_name override when referenced in mutation arguments", () => {
    // This test specifically covers the case where two namespaces define classes
    // with the same Ruby class name but different graphql_names.  Without rubyPath
    // disambiguation, Marquee's ShowEventType would resolve to TentSpace's
    // TentShowEvent type (since "TentShowEvent" is already in the registry first).
    const typeDefs = [
      // TentSpace types with shorter graphql_names are registered first (simulating
      // the production scenario where they'd win the normalizeRubyType lookup)
      parseRubyTypeDefinition(
        SPACES_CALENDAR_EVENT_TYPE_FIXTURE,
        "tent_space/show_event_type.rb"
      )!,
      parseRubyTypeDefinition(
        SPACES_CALENDAR_EVENT_INPUT_FIXTURE,
        "tent_space/show_event_input.rb"
      )!,
      // Marquee types with the fully-qualified ::Marquee::Graphql:: refs
      parseRubyTypeDefinition(
        CALENDAR_EVENT_TYPE_FIXTURE,
        "marquee/show_event_type.rb"
      )!,
      parseRubyTypeDefinition(
        CALENDAR_EVENT_INPUT_FIXTURE,
        "marquee/show_event_input.rb"
      )!,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query_type.rb")!,
    ]
    const resolvers = [
      parseResolverDefinition(
        CREATE_OR_UPDATE_CALENDAR_EVENT_MUTATION_FIXTURE,
        "marquee/create_or_update_show_event_mutation.rb"
      )!,
    ]
    const registrations: ResolverRegistration[] = [
      {
        fieldName: "createOrUpdateShowEvent",
        resolverClassName: "Marquee::Graphql::CreateOrUpdateShowEventMutation",
        target: "mutation",
      },
    ]

    const schema = buildGraphQLSchema(typeDefs, resolvers, registrations)
    const mutationType = schema.getMutationType()!
    const field = mutationType.getFields()["createOrUpdateShowEvent"]

    expect(field).toBeDefined()

    // Return type must be exactly MarqueeShowEvent!, NOT TentShowEvent! (TentSpace)
    expect(field.type.toString()).toBe("MarqueeShowEvent!")

    // The input argument should resolve to MarqueeShowEventInput, NOT TentShowEventInput (TentSpace)
    const inputArg = field.args.find(a => a.name === "input")
    expect(inputArg).toBeDefined()
    expect(inputArg!.type.toString()).toContain("MarqueeShowEventInput")

    // The output type should exist with correct Marquee fields
    const outputType = schema.getType("MarqueeShowEvent") as any
    expect(outputType).toBeDefined()
    const outputFields = outputType.getFields()
    expect(outputFields["title"]).toBeDefined()
    expect(outputFields["location"]).toBeDefined()
    expect(outputFields["startDate"]).toBeDefined()
    // TentSpace's field (summary) must NOT appear on Marquee's type
    expect(outputFields["summary"]).toBeUndefined()

    // The input type should exist with correct Marquee fields
    const inputType = schema.getType("MarqueeShowEventInput") as any
    expect(inputType).toBeDefined()
    const inputFields = inputType.getFields()
    expect(inputFields["title"]).toBeDefined()
    expect(inputFields["location"]).toBeDefined()
    // TentSpace's field (description) must NOT appear on Marquee's input
    expect(inputFields["description"]).toBeUndefined()

    // TentSpace types must still exist independently with their own fields
    const spacesOutputType = schema.getType("TentShowEvent") as any
    expect(spacesOutputType).toBeDefined()
    const spacesOutputFields = spacesOutputType.getFields()
    expect(spacesOutputFields["summary"]).toBeDefined()

    const spacesInputType = schema.getType("TentShowEventInput") as any
    expect(spacesInputType).toBeDefined()
    const spacesInputFields = spacesInputType.getFields()
    expect(spacesInputFields["description"]).toBeDefined()
  })

  it("should inherit fields from parent type", () => {
    const typeDefs = [
      parseRubyTypeDefinition(PROJECT_TASK_TYPE_FIXTURE, "show_task_type.rb")!,
      parseRubyTypeDefinition(SERVICE_TASK_TYPE_FIXTURE, "rig_task_type.rb")!,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query.rb")!,
    ]
    const schema = buildGraphQLSchema(typeDefs)
    // RigTaskType inherits from ShowTaskType
    const rigTaskType = schema.getType("HighWireRigTask")
    expect(rigTaskType).toBeDefined()
    const fields = (rigTaskType as any).getFields()
    // Own fields
    expect(fields["storageTent"]).toBeDefined()
    expect(fields["vipHolderIds"]).toBeDefined()
    // Inherited from ShowTaskType
    expect(fields["id"]).toBeDefined()
    expect(fields["scheduledDate"]).toBeDefined()
    expect(fields["show"]).toBeDefined()
    expect(fields["showSlot"]).toBeDefined()
  })

  it("should build input type inheriting from another InputType", () => {
    const typeDefs = [
      parseRubyTypeDefinition(
        POINT_OF_INTEREST_INPUT_TYPE_FIXTURE,
        "ring_marker_input.rb"
      )!,
      parseRubyTypeDefinition(
        TERRITORY_ZONE_INPUT_TYPE_FIXTURE,
        "circus_territory_zone_input.rb"
      )!,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query.rb")!,
    ]
    // Should build schema without throwing "must be Input Type" error
    expect(() => buildGraphQLSchema(typeDefs)).not.toThrow()
    const schema = buildGraphQLSchema(typeDefs)
    const zoneInput = schema.getType("CircusTerritoryZoneInput")
    expect(zoneInput).toBeDefined()
    const fields = (zoneInput as any).getFields()
    // Own arguments
    expect(fields["id"]).toBeDefined()
    expect(fields["color"]).toBeDefined()
    // Inherited from RingMarkerInputType
    expect(fields["name"]).toBeDefined()
    expect(fields["latitude"]).toBeDefined()
    expect(fields["longitude"]).toBeDefined()
  })

  it("should register module-based interface and resolve field types that reference it", () => {
    const typeDefs = [
      parseRubyTypeDefinition(
        MODULE_INTERFACE_FIXTURE,
        "show_item_interface.rb"
      )!,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query.rb")!,
    ]
    expect(() => buildGraphQLSchema(typeDefs)).not.toThrow()
    const schema = buildGraphQLSchema(typeDefs)
    // Registered under the full module name (Interface suffix kept by deriveTypeName)
    const ifaceType = schema.getType("ShowItemInterface")
    expect(ifaceType).toBeDefined()
    // Its fields should be accessible (id, model, prop)
    const fields = (ifaceType as any).getFields()
    expect(fields["id"]).toBeDefined()
    expect(fields["model"]).toBeDefined()
    expect(fields["prop"]).toBeDefined()
  })

  it("should parse a union type (BaseUnion) with possible_types", () => {
    const def = parseRubyTypeDefinition(
      `
module HighWire
  module Graphql
    class ActItemType < CircusApp::Types::BaseUnion
      graphql_name "HighWireActItemType"
      possible_types ShowQuoteItemType, ShowQuoteExtraType
    end
  end
end
`,
      "act_item_type.rb"
    )
    expect(def).not.toBeNull()
    expect(def!.kind).toBe("union")
    expect(def!.name).toBe("HighWireActItemType")
    expect(def!.possibleTypes).toEqual(["ShowQuoteItem", "ShowQuoteExtra"])
  })

  it("should parse a union type with parenthesised multiline possible_types", () => {
    const def = parseRubyTypeDefinition(
      `
module HighWire
  module Graphql
    class ActItemType < CircusApp::Types::BaseUnion
      graphql_name "HighWireActItemType"
      possible_types(
        ::HighWire::Graphql::ShowQuoteItemType,
        ::HighWire::Graphql::ShowQuoteExtraType
      )
    end
  end
end
`,
      "act_item_type.rb"
    )
    expect(def).not.toBeNull()
    expect(def!.kind).toBe("union")
    expect(def!.possibleTypes).toEqual(["ShowQuoteItem", "ShowQuoteExtra"])
  })

  it("should build a union type in the schema and allow inline fragment spreads", () => {
    const showQuoteItemType = parseRubyTypeDefinition(
      `
module HighWire
  module Graphql
    class ShowQuoteItemType < CircusApp::Types::BaseObject
      graphql_name "ShowQuoteItemType"
      field :id, ID, null: false
      field :item_charge, Float
    end
  end
end
`,
      "show_quote_item_type.rb"
    )!

    const showQuoteExtraType = parseRubyTypeDefinition(
      `
module HighWire
  module Graphql
    class ShowQuoteExtraType < CircusApp::Types::BaseObject
      graphql_name "ShowQuoteExtraType"
      field :id, ID, null: false
      field :name, String
    end
  end
end
`,
      "show_quote_extra_type.rb"
    )!

    const actItemUnion = parseRubyTypeDefinition(
      `
module HighWire
  module Graphql
    class ActItemType < CircusApp::Types::BaseUnion
      graphql_name "HighWireActItemType"
      possible_types ShowQuoteItemType, ShowQuoteExtraType
    end
  end
end
`,
      "act_item_type.rb"
    )!

    expect(actItemUnion.kind).toBe("union")
    expect(actItemUnion.possibleTypes).toEqual([
      "ShowQuoteItem",
      "ShowQuoteExtra",
    ])

    const typeDefs = [
      showQuoteItemType,
      showQuoteExtraType,
      actItemUnion,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query.rb")!,
    ]
    expect(() => buildGraphQLSchema(typeDefs)).not.toThrow()
    const schema = buildGraphQLSchema(typeDefs)

    // Union type itself should be in the schema
    const unionType = schema.getType("HighWireActItemType")
    expect(unionType).toBeDefined()
    expect(unionType).toBeInstanceOf(require("graphql").GraphQLUnionType)

    // The member types should be accessible
    const memberNames = (unionType as any).getTypes().map((t: any) => t.name)
    expect(memberNames).toContain("ShowQuoteItemType")
    expect(memberNames).toContain("ShowQuoteExtraType")
  })

  it("should parse inline field arguments from do...end blocks on interface fields", () => {
    const def = parseRubyTypeDefinition(
      `
module HighWire
  module Graphql
    module ShowItemInterface
      include CircusApp::Types::BaseInterface

      field :id, ID, null: false
      field :media_items, [String], access: %i[private customer] do
        argument :document_type_code, [String], required: false
      end
    end
  end
end
`,
      "show_item_interface.rb"
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
module HighWire
  module Graphql
    module ShowItemInterface
      include CircusApp::Types::BaseInterface

      field :id, ID, null: false
      field :media_items, [String], access: %i[private customer] do
        argument :document_type_code, [String], required: false
      end
    end
  end
end
`,
      "show_item_interface.rb"
    )!

    const typeDefs = [
      ifaceTypeDef,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query.rb")!,
    ]
    expect(() => buildGraphQLSchema(typeDefs)).not.toThrow()
    const schema = buildGraphQLSchema(typeDefs)

    const ifaceType = schema.getType("ShowItemInterface") as any
    expect(ifaceType).toBeDefined()
    const mediaItemsField = ifaceType.getFields()["mediaItems"]
    expect(mediaItemsField).toBeDefined()
    // The field must expose the documentTypeCode argument
    const argNames = mediaItemsField.args.map((a: any) => a.name)
    expect(argNames).toContain("documentTypeCode")
  })

  it("should resolve field type via typeRubyPath when two types share the same classBasedName", () => {
    // Reproduces the PropAsset collision:
    //   PropHouse::Graphql::PropAssetType  → graphql_name "PropAsset"
    //   BigTop::Graphql::PropAssetType     → graphql_name "prop_item"
    // Both normalise to "PropAsset" via normalizeRubyType.  Without
    // typeRubyPath tracking the field would pick up the wrong (simpler) type.
    const typeDefs = [
      // Register the simpler type first so it pre-occupies the "PropAsset" name
      parseRubyTypeDefinition(
        EQUIPMENT_ASSETS_EQUIPMENT_ASSET_TYPE_FIXTURE,
        "prop_house/prop_asset_type.rb"
      )!,
      parseRubyTypeDefinition(
        DIRECTORY_EQUIPMENT_ASSET_TYPE_FIXTURE,
        "big_top/prop_asset_type.rb"
      )!,
      parseRubyTypeDefinition(
        EMPLOYEE_WITH_EQUIPMENT_TYPE_FIXTURE,
        "big_top/performer_type.rb"
      )!,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query_type.rb")!,
    ]
    const schema = buildGraphQLSchema(typeDefs)

    const employeeType = schema.getType("Performer") as any
    expect(employeeType).toBeDefined()
    const empFields = employeeType.getFields()

    // The field must exist and resolve to "prop_item" (BigTop's version)
    const equipField = empFields["propAssets"]
    expect(equipField).toBeDefined()

    // Unwrap list/non-null wrappers to get the base named type
    let elementType: any = equipField.type
    while (elementType.ofType) elementType = elementType.ofType
    expect(elementType.name).toBe("prop_item")

    // BigTop's "prop_item" type must have the richer fields
    const assetType = schema.getType("prop_item") as any
    expect(assetType).toBeDefined()
    const assetFields = assetType.getFields()
    expect(assetFields["propSerial"]).toBeDefined()
    expect(assetFields["status"]).toBeDefined()

    // The simpler "PropAsset" type must still exist but lacks propSerial
    const simpleType = schema.getType("PropAsset") as any
    expect(simpleType).toBeDefined()
    expect(simpleType.getFields()["propSerial"]).toBeUndefined()
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

    const domainType = schema.getType("BackstageHub") as any
    expect(domainType).toBeDefined()
    const domainFields = domainType.getFields()

    const paginatedField = domainFields["showSeats"]
    expect(paginatedField).toBeDefined()

    // Return type must be ShowSeatsResult (from the resolver declaration)
    let returnType: any = paginatedField.type
    while (returnType.ofType) returnType = returnType.ofType
    expect(returnType.name).toBe("ShowSeatsResult")

    // Arguments from ShowSeatsQuery must be exposed on the field
    const argNames: string[] = paginatedField.args.map((a: any) => a.name)
    expect(argNames).toContain("search")
    expect(argNames).toContain("page")
    expect(argNames).toContain("perPage")

    // ShowSeatsResult type must have its own fields
    const resultType = schema.getType("ShowSeatsResult") as any
    expect(resultType).toBeDefined()
    const resultFields = resultType.getFields()
    expect(resultFields["totalCount"]).toBeDefined()
    expect(resultFields["seats"]).toBeDefined()
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

    const appointmentType = schema.getType("ShowSlot") as any
    expect(appointmentType).toBeDefined()
    const appointmentFields = appointmentType.getFields()

    // Fields with camelize: false should keep their snake_case names
    expect(appointmentFields["new_acts_plan"]).toBeDefined()
    expect(appointmentFields["status_code"]).toBeDefined()

    // Fields without camelize: false should be camelCased
    expect(appointmentFields["showTime"]).toBeDefined()

    // The incorrectly camelCased versions should NOT exist
    expect(appointmentFields["newActsPlan"]).toBeUndefined()
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

    const employeeType = schema.getType("Performer") as any
    expect(employeeType).toBeDefined()
    const employeeFields = employeeType.getFields()

    // Field should exist
    const phoneNumbersField = employeeFields["ringTones"]
    expect(phoneNumbersField).toBeDefined()

    // Unwrap list and non-null wrappers to get base type
    let elementType: any = phoneNumbersField.type
    while (elementType.ofType) {
      elementType = elementType.ofType
    }

    // Base type should be RingTone, not some unknown mangled type
    expect(elementType.name).toBe("RingTone")

    // RingTone type must be properly resolved with its fields
    const phoneNumberType = schema.getType("RingTone") as any
    expect(phoneNumberType).toBeDefined()
    const phoneNumberFields = phoneNumberType.getFields()
    expect(phoneNumberFields["extension"]).toBeDefined()
    expect(phoneNumberFields["number"]).toBeDefined()
  })

  it("should handle field with do...end block for inline arguments", () => {
    // A field can open a `do...end` block to declare inline arguments:
    //   field :pay_period_summary, Juggler::Graphql::JugglerPaySummaryType do
    //     argument :date, CircusApp::Types::Date, required: false
    //   end
    // The ` do` suffix must not corrupt the type name, and the argument must be wired up.
    const payPeriodSummaryType = parseRubyTypeDefinition(
      `
module Juggler
  module Graphql
    class JugglerPaySummaryType < CircusApp::Types::BaseObject
      graphql_name "JugglerPaySummary"
      description "A juggler pay period summary"

      field :id, ID, null: false
      field :total_pay, Float, null: false
    end
  end
end
`,
      "juggler/juggler_pay_summary_type.rb"
    )!

    const jugglerType = parseRubyTypeDefinition(
      `
module Juggler
  module Graphql
    class JugglerType < CircusApp::Types::BaseObject
      graphql_name "Juggler"
      description "A juggler"

      field :id, ID, null: false
      field :pay_period_summary, Juggler::Graphql::JugglerPaySummaryType do
        argument :date, String, required: false
      end
    end
  end
end
`,
      "juggler/juggler_type.rb"
    )!

    const typeDefs = [
      payPeriodSummaryType,
      jugglerType,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query_type.rb")!,
    ]
    const schema = buildGraphQLSchema(typeDefs)

    const jugglerGqlType = schema.getType("Juggler") as any
    expect(jugglerGqlType).toBeDefined()
    const fields = jugglerGqlType.getFields()

    // Field must exist and resolve to JugglerPaySummary, not unknown
    const field = fields["payPeriodSummary"]
    expect(field).toBeDefined()

    let elementType: any = field.type
    while (elementType.ofType) elementType = elementType.ofType
    expect(elementType.name).toBe("JugglerPaySummary")

    // The inline argument `date` must be wired up on the field
    const dateArg = field.args?.find((a: any) => a.name === "date")
    expect(dateArg).toBeDefined()

    // JugglerPaySummary must have its own fields
    const summaryType = schema.getType("JugglerPaySummary") as any
    expect(summaryType).toBeDefined()
    const summaryFields = summaryType.getFields()
    expect(summaryFields["id"]).toBeDefined()
    expect(summaryFields["totalPay"]).toBeDefined()
  })
})

describe("resolver namespace collision", () => {
  it("should pick the correct resolver when two namespaces define the same class name", () => {
    // Reproduces the real case:
    //   field :pending_high_wire_act_revisions,
    //         resolver: ::HighWire::Graphql::PendingActRevisionsQuery
    //
    // Two components both have a resolver named PendingActRevisionsQuery
    // but in different namespaces with different arguments.  The field name has
    // "high_wire" in it but the class name does not — make sure that does not
    // confuse the matching and that the explicit resolver: path wins.

    const highWireResolver = parseResolverDefinition(
      `
module HighWire
  module Graphql
    class PendingActRevisionsQuery < CircusApp::BaseQuery
      type [::HighWire::Graphql::ActRevisionType], null: true

      argument :show_quote_id, ID

      def resolve(show_quote_id:)
      end
    end
  end
end
`,
      "high_wire/pending_act_revisions_query.rb"
    )!

    const bigShowsResolver = parseResolverDefinition(
      `
module BigShows
  module Graphql
    class PendingActRevisionsQuery < CircusApp::BaseQuery
      type [String], null: true

      argument :show_id, ID
      argument :prop_id, ID

      def resolve(show_id:, prop_id:)
      end
    end
  end
end
`,
      "big_shows/pending_act_revisions_query.rb"
    )!

    expect(highWireResolver.className).toBe(
      "HighWire::Graphql::PendingActRevisionsQuery"
    )
    expect(bigShowsResolver.className).toBe(
      "BigShows::Graphql::PendingActRevisionsQuery"
    )

    const actRevisionType = parseRubyTypeDefinition(
      `
module HighWire
  module Graphql
    class ActRevisionType < CircusApp::Types::BaseObject
      field :id, ID, null: false
    end
  end
end
`,
      "act_revision_type.rb"
    )!

    const registrations: ResolverRegistration[] = [
      {
        fieldName: "pendingHighWireActRevisions",
        resolverClassName: "::HighWire::Graphql::PendingActRevisionsQuery",
        target: "query",
      },
    ]

    // Pass both resolvers — BigShows resolver must NOT win
    const schema = buildGraphQLSchema(
      [actRevisionType],
      [highWireResolver, bigShowsResolver],
      registrations
    )

    const queryType = schema.getQueryType()!
    const field = queryType.getFields()["pendingHighWireActRevisions"]
    expect(field).toBeDefined()

    const argNames = field.args.map(a => a.name)
    // Must have showQuoteId from the HighWire resolver
    expect(argNames).toContain("showQuoteId")
    // Must NOT have showId / propId from the BigShows resolver
    expect(argNames).not.toContain("showId")
    expect(argNames).not.toContain("propId")
  })

  it("should also pick correct resolver when BigShows resolver is inserted first in map order", () => {
    const highWireResolver = parseResolverDefinition(
      `
module HighWire
  module Graphql
    class PendingActRevisionsQuery < CircusApp::BaseQuery
      type [String], null: true
      argument :show_quote_id, ID
      def resolve(show_quote_id:); end
    end
  end
end
`,
      "high_wire/pending_act_revisions_query.rb"
    )!

    const bigShowsResolver = parseResolverDefinition(
      `
module BigShows
  module Graphql
    class PendingActRevisionsQuery < CircusApp::BaseQuery
      type [String], null: true
      argument :show_id, ID
      argument :prop_id, ID
      def resolve(show_id:, prop_id:); end
    end
  end
end
`,
      "big_shows/pending_act_revisions_query.rb"
    )!

    const registrations: ResolverRegistration[] = [
      {
        fieldName: "pendingHighWireActRevisions",
        // leading :: is stripped during matching
        resolverClassName: "::HighWire::Graphql::PendingActRevisionsQuery",
        target: "query",
      },
    ]

    // BigShows resolver passed first — must still resolve to HighWire
    const schema = buildGraphQLSchema(
      [],
      [bigShowsResolver, highWireResolver],
      registrations
    )

    const queryType = schema.getQueryType()!
    const field = queryType.getFields()["pendingHighWireActRevisions"]
    expect(field).toBeDefined()

    const argNames = field.args.map(a => a.name)
    expect(argNames).toContain("showQuoteId")
    expect(argNames).not.toContain("showId")
    expect(argNames).not.toContain("propId")
  })

  it("should prefer same-namespace type over identically-named type in different namespace", () => {
    // Reproduces: Juggler::Graphql::BookJugglerMutation declares
    //   type PerformanceType, null: false
    // Ruby resolves unqualified names by looking in the enclosing namespace first.
    // Juggler::Graphql::PerformanceType must win over BigShows::Graphql::PerformanceType.

    const jugglerPerformanceType = parseRubyTypeDefinition(
      `
module Juggler
  module Graphql
    class PerformanceType < CircusApp::Types::BaseObject
      graphql_name "JugglerPerformance"
      field :id, ID, null: false
      field :status, String
    end
  end
end
`,
      "juggler/graphql/performance_type.rb"
    )!

    const bigShowsPerformanceType = parseRubyTypeDefinition(
      `
module BigShows
  module Graphql
    class PerformanceType < CircusApp::Types::BaseObject
      field :icon, String, null: false
      field :color, String, null: false
    end
  end
end
`,
      "big_shows/graphql/performance_type.rb"
    )!

    const jugglerMutation = parseResolverDefinition(
      `
module Juggler
  module Graphql
    class BookJugglerMutation < CircusApp::BaseQuery
      type PerformanceType, null: false
      argument :act_id, ID
      def resolve(act_id:); end
    end
  end
end
`,
      "juggler/graphql/book_juggler_mutation.rb"
    )!

    // returnTypeRubyPath must be set to the namespace-qualified candidate
    expect(jugglerMutation.returnTypeRubyPath).toBe(
      "Juggler::Graphql::PerformanceType"
    )

    const registrations: ResolverRegistration[] = [
      {
        fieldName: "bookJuggler",
        resolverClassName: "Juggler::Graphql::BookJugglerMutation",
        target: "mutation",
      },
    ]

    const schema = buildGraphQLSchema(
      [
        jugglerPerformanceType,
        bigShowsPerformanceType,
        parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query_type.rb")!,
      ],
      [jugglerMutation],
      registrations
    )

    const mutationType = schema.getMutationType()!
    const field = mutationType.getFields()["bookJuggler"]
    expect(field).toBeDefined()

    // Unwrap NonNull to get the base type
    let baseType: any = field.type
    while (baseType.ofType) baseType = baseType.ofType

    // Must resolve to JugglerPerformance, not Performance (BigShows one)
    expect(baseType.name).toBe("JugglerPerformance")
  })

  it("should extract component namespace from registration file for resolver disambiguation", () => {
    // When a registration file is parsed, the component namespace is extracted
    // from the outer module declaration and attached to each registration.
    // This enables findResolver to prefer same-namespace resolvers when
    // multiple components define resolvers with the same class name.
    const content = `
module TerritoryMaps
  module Graphql
    extend ::CircusApp::Schema::Partial

    queries do
      field :cd_reps, resolver: TeamsQuery
      field :rc_reps, resolver: TeamsQuery
    end
  end
end
`
    const registrations = parseRegistrationFile(content)
    expect(registrations.length).toBe(2)

    // All registrations from TerritoryMaps should have the component namespace
    expect(registrations[0].componentNamespace).toBe("TerritoryMaps")
    expect(registrations[1].componentNamespace).toBe("TerritoryMaps")

    const cdReps = registrations.find(r => r.fieldName === "cdReps")
    expect(cdReps).toBeDefined()
    expect(cdReps!.componentNamespace).toBe("TerritoryMaps")
    expect(cdReps!.resolverClassName).toBe("TeamsQuery") // unqualified
  })
})

describe("validateSchemaIntegrity", () => {
  it("should return empty array for valid schema", () => {
    const typeDefs = [
      parseRubyTypeDefinition(COUNTRY_TYPE_FIXTURE, "tent.rb")!,
      parseRubyTypeDefinition(QUERY_TYPE_FIXTURE, "query.rb")!,
      parseRubyTypeDefinition(ACCESS_TYPE_FIXTURE, "performer.rb")!,
      parseRubyTypeDefinition(INTERFACE_TYPE_FIXTURE, "crowd.rb")!,
      parseRubyTypeDefinition(COURSE_TYPE_FIXTURE, "act.rb")!,
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
    fs.writeFileSync(
      path.join(gqlDir, "performer_type.rb"),
      ACCESS_TYPE_FIXTURE
    )
    fs.writeFileSync(path.join(gqlDir, "tent_type.rb"), COUNTRY_TYPE_FIXTURE)
    fs.writeFileSync(
      path.join(gqlDir, "crowd_interface.rb"),
      INTERFACE_TYPE_FIXTURE
    )
    fs.writeFileSync(path.join(gqlDir, "act_type.rb"), COURSE_TYPE_FIXTURE)

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
      "high_wire",
      "app",
      "graphql",
      "high_wire",
      "graphql"
    )
    fs.mkdirSync(gqlDir, { recursive: true })
    fs.writeFileSync(
      path.join(gqlDir, "clown_stats_type.rb"),
      AGENT_STATS_TYPE_FIXTURE
    )
    fs.writeFileSync(
      path.join(gqlDir, "clown_stats_query.rb"),
      AGENT_STATS_QUERY_FIXTURE
    )

    // Create registration file
    const regDir = path.join(
      tmpDir,
      "components",
      "high_wire",
      "lib",
      "high_wire"
    )
    fs.mkdirSync(regDir, { recursive: true })
    fs.writeFileSync(path.join(regDir, "graphql.rb"), REGISTRATION_FILE_FIXTURE)

    const result = buildSchemaFromDirectory(tmpDir)
    expect(result.schema).toBeDefined()
    expect(result.resolverCount).toBeGreaterThan(0)
    expect(result.registrationCount).toBeGreaterThan(0)

    const queryType = result.schema.getQueryType()!
    const fields = queryType.getFields()
    expect(fields["troupeStats"]).toBeDefined()
  })
})

// ── New Test Suites ────────────────────────────────────────────────────────────

describe("snakeToCamel", () => {
  it("should convert snake_case to camelCase", () => {
    expect(snakeToCamel("troupe_stats")).toBe("troupeStats")
    expect(snakeToCamel("show_routes")).toBe("showRoutes")
    expect(snakeToCamel("count_guest_arrivals")).toBe("countGuestArrivals")
  })

  it("should leave already camelCase strings unchanged", () => {
    expect(snakeToCamel("troupeStats")).toBe("troupeStats")
    expect(snakeToCamel("id")).toBe("id")
  })

  it("should handle single words", () => {
    expect(snakeToCamel("name")).toBe("name")
  })

  it("should handle multiple underscores", () => {
    expect(snakeToCamel("main_circus_show_events_query")).toBe(
      "mainCircusShowEventsQuery"
    )
  })
})

describe("parseResolverDefinition", () => {
  it("should parse a query resolver with arguments and return type", () => {
    const resolver = parseResolverDefinition(
      AGENT_STATS_QUERY_FIXTURE,
      "clown_stats_query.rb"
    )
    expect(resolver).not.toBeNull()
    expect(resolver!.className).toBe("HighWire::Graphql::ClownStatsQuery")
    expect(resolver!.returnType).toBe("ClownStats")
    expect(resolver!.returnTypeIsList).toBe(true)
    expect(resolver!.returnTypeNullable).toBe(false)
    expect(resolver!.arguments.length).toBe(3)
  })

  it("should parse argument names as camelCase", () => {
    const resolver = parseResolverDefinition(
      AGENT_STATS_QUERY_FIXTURE,
      "clown_stats_query.rb"
    )!
    const clownIdsArg = resolver.arguments.find(a => a.name === "clownIds")
    expect(clownIdsArg).toBeDefined()
    expect(clownIdsArg!.isList).toBe(true)
    expect(clownIdsArg!.type).toBe("ID")

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
      "book_show_equipment_mutation.rb"
    )!
    expect(resolver.className).toBe(
      "HighWire::Graphql::BookShowEquipmentMutation"
    )
    expect(resolver.returnType).toBe("PropOrder")
    expect(resolver.returnTypeIsList).toBe(true)
    expect(resolver.isConnectionType).toBe(false)

    const showIdArg = resolver.arguments.find(a => a.name === "showId")
    expect(showIdArg).toBeDefined()
    expect(showIdArg!.type).toBe("ID")
    expect(showIdArg!.required).toBe(true)

    const seatNumberArg = resolver.arguments.find(a => a.name === "seatNumber")
    expect(seatNumberArg).toBeDefined()
    expect(seatNumberArg!.required).toBe(false)
  })

  it("should parse a mutation with input type argument", () => {
    const resolver = parseResolverDefinition(
      CANCEL_SERVICE_APPOINTMENT_MUTATION_FIXTURE,
      "cancel_show_booking_mutation.rb"
    )!
    const attrsArg = resolver.arguments.find(a => a.name === "attributes")
    expect(attrsArg).toBeDefined()
    expect(attrsArg!.type).toBe("ShowBookingInput")
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
    const resolver = parseResolverDefinition(COURSE_TYPE_FIXTURE, "act_type.rb")
    expect(resolver).toBeNull()
  })

  it("should return null for files without a class definition", () => {
    const resolver = parseResolverDefinition("module Foo; end", "foo.rb")
    expect(resolver).toBeNull()
  })

  it("should parse .connection_type syntax and set isConnectionType flag", () => {
    const resolver = parseResolverDefinition(
      TIME_OFF_BALANCE_CONNECTION_QUERY_FIXTURE,
      "break_credit_query.rb"
    )!
    expect(resolver).not.toBeNull()
    expect(resolver.returnType).toBe("BreakCredit")
    expect(resolver.returnTypeIsList).toBe(false)
    expect(resolver.isConnectionType).toBe(true)
    expect(resolver.returnTypeNullable).toBe(false)
    expect(resolver.arguments.length).toBe(2)
  })

  it("should parse resolvers with intermediate base classes (e.g., Support::Graphql::TicketQuery)", () => {
    const content = `
      module ProjectSupportTickets
        module Graphql
          class TicketQuery < Support::Graphql::TicketQuery
            description "Returns a Ticket for the given ticket ID"

            type TicketType, null: false

            argument :ticket_id, ID
            def resolve(ticket_id:)
              ticket = SupportTicketModel::Ticket.find(ticket_id)
              ticket
            end
          end
        end
      end
    `
    const resolver = parseResolverDefinition(content, "ticket_query.rb")
    expect(resolver).not.toBeNull()
    expect(resolver!.className).toBe(
      "ProjectSupportTickets::Graphql::TicketQuery"
    )
    expect(resolver!.returnType).toBe("Ticket")
    expect(resolver!.returnTypeNullable).toBe(false)
    expect(resolver!.arguments.length).toBe(1)
    const ticketIdArg = resolver!.arguments.find(a => a.name === "ticketId")
    expect(ticketIdArg).toBeDefined()
    expect(ticketIdArg!.type).toBe("ID")
    expect(ticketIdArg!.required).toBe(true)
  })

  it("should parse resolvers with intermediate base classes that end in Mutation", () => {
    const content = `
      module CustomFeature
        module Graphql
          class UpdateRecordMutation < Support::Graphql::BaseMutation
            type String, null: false
            argument :id, ID
            def resolve(id:)
              "success"
            end
          end
        end
      end
    `
    const resolver = parseResolverDefinition(
      content,
      "update_record_mutation.rb"
    )
    expect(resolver).not.toBeNull()
    expect(resolver!.className).toBe(
      "CustomFeature::Graphql::UpdateRecordMutation"
    )
    expect(resolver!.returnType).toBe("String")
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
    const content = "argument :clown_ids, [ID]"
    const args = parseArguments(content)
    expect(args.length).toBe(1)
    expect(args[0].name).toBe("clownIds")
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
      argument :show_id, ID
      argument :seat_number, String, required: false
      argument :items, [HighWire::Graphql::ShowEquipmentItemInputType]
    `
    const args = parseArguments(content)
    expect(args.length).toBe(3)
    expect(args[0].name).toBe("showId")
    expect(args[1].name).toBe("seatNumber")
    expect(args[2].name).toBe("items")
    expect(args[2].isList).toBe(true)
  })

  it("should parse argument with namespaced input type", () => {
    const content =
      "argument :attributes, ::HighWire::Graphql::ShowBookingInputType"
    const args = parseArguments(content)
    expect(args.length).toBe(1)
    expect(args[0].type).toBe("ShowBookingInput")
  })

  it("should parse multi-line argument definitions", () => {
    const content = `argument :with_exclude_from_directory,
               Boolean,
               required: false,
               default_value: false,
               description: "Set to true if you want excludeFromDirectory in your results."
argument :search, CircusApp::Types::Json, required: false
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
    expect(field!.resolverClassName).toContain("ClownStatsQuery")
    expect(field!.target).toBe("query")
  })

  it("should convert field names to camelCase", () => {
    const registrations = parseRegistrationFile(REGISTRATION_FILE_FIXTURE)
    const troupeStats = registrations.find(r => r.fieldName === "troupeStats")
    expect(troupeStats).toBeDefined()
    expect(troupeStats!.resolverClassName).toContain("ClownStatsQuery")

    const cancelBooking = registrations.find(
      r => r.fieldName === "cancelShowBooking"
    )
    expect(cancelBooking).toBeDefined()
  })

  it("should extract correct resolver class names", () => {
    const registrations = parseRegistrationFile(REGISTRATION_FILE_FIXTURE)
    const bookEquipment = registrations.find(
      r => r.fieldName === "bookShowEquipment"
    )
    expect(bookEquipment).toBeDefined()
    expect(bookEquipment!.resolverClassName).toContain(
      "BookShowEquipmentMutation"
    )
    expect(bookEquipment!.target).toBe("mutation")
  })

  it("should return empty array for files with no registrations", () => {
    const registrations = parseRegistrationFile(`
module Foo
  module Graphql
    extend ::CircusApp::Schema::Partial
  end
end
`)
    expect(registrations).toEqual([])
  })

  it("should handle queries-only registration file", () => {
    const content = `
module Foo
  module Graphql
    extend ::CircusApp::Schema::Partial

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
    extend ::CircusApp::Schema::Partial

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
    extend ::CircusApp::Schema::Partial

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
    // Complex permission hashes like { Show => :create } fall back to private
    const registrations = parseRegistrationFile(REGISTRATION_FILE_FIXTURE)
    const field = registrations.find(r => r.fieldName === "bookShowEquipment")
    expect(field).toBeDefined()
    expect(field!.access).toEqual(["private"])
  })

  it("should parse mutation: keyword as resolver in mutation fields", () => {
    const content = `
module HighWire
  module Graphql
    extend ::CircusApp::Schema::Partial

    mutations do
      field :upsert_acrobat_bonus_plan,
            mutation: ::HighWire::Graphql::UpsertAcrobatBonusPlanMutation
      field :delete_acrobat_benefit,
            mutation: ::HighWire::Graphql::DeleteAcrobatBenefitMutation
    end
  end
end
`
    const registrations = parseRegistrationFile(content)
    expect(registrations.length).toBe(2)

    const upsertBonus = registrations.find(
      r => r.fieldName === "upsertAcrobatBonusPlan"
    )
    expect(upsertBonus).toBeDefined()
    expect(upsertBonus!.resolverClassName).toBe(
      "HighWire::Graphql::UpsertAcrobatBonusPlanMutation"
    )
    expect(upsertBonus!.target).toBe("mutation")

    const deleteBonus = registrations.find(
      r => r.fieldName === "deleteAcrobatBenefit"
    )
    expect(deleteBonus).toBeDefined()
    expect(deleteBonus!.resolverClassName).toBe(
      "HighWire::Graphql::DeleteAcrobatBenefitMutation"
    )
    expect(deleteBonus!.target).toBe("mutation")
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
      "high_wire",
      "lib",
      "high_wire"
    )
    fs.mkdirSync(regDir, { recursive: true })
    fs.writeFileSync(path.join(regDir, "graphql.rb"), "# test")

    const files = findRegistrationFiles(tmpDir)
    expect(files.length).toBe(1)
    expect(files[0]).toContain("graphql.rb")
  })

  it("should find multiple component registration files", () => {
    const dirs = [
      path.join(tmpDir, "components", "high_wire", "lib", "high_wire"),
      path.join(tmpDir, "components", "backstage", "lib", "backstage"),
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
module CircusApp
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
    expect(result!.modulePath).toBe("CircusApp::PaginationArguments")
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
module CircusApp
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
    expect(registry.has("CircusApp::PaginationArguments")).toBe(true)

    const args = registry.get("CircusApp::PaginationArguments")!
    expect(args.map(a => a.name)).toEqual(["page", "perPage"])
  })
})

describe("loadMixinFiles", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nitro-mixin-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("should find mixin files in lib/ directories that the graphql scanner misses", () => {
    // Simulate: components/circus_app/lib/circus_app/pagination_arguments.rb
    const libDir = path.join(tmpDir, "lib", "circus_app")
    fs.mkdirSync(libDir, { recursive: true })

    fs.writeFileSync(
      path.join(libDir, "pagination_arguments.rb"),
      `
module CircusApp
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
    )

    // Also create a non-mixin file in the lib dir to confirm it's filtered out
    fs.writeFileSync(
      path.join(libDir, "base_query.rb"),
      `
module CircusApp
  class BaseQuery < GraphQL::Schema::Resolver
  end
end
`
    )

    // Also create a graphql dir file to confirm it's NOT double-scanned from loadMixinFiles
    const graphqlDir = path.join(tmpDir, "graphql")
    fs.mkdirSync(graphqlDir, { recursive: true })
    fs.writeFileSync(
      path.join(graphqlDir, "some_type.rb"),
      `
class SomeType < CircusApp::Types::BaseObject
  field :id, ID
end
`
    )

    const mixinFiles = loadMixinFiles(tmpDir)

    // Should find pagination_arguments.rb (has self.included + argument)
    expect(mixinFiles.size).toBe(1)
    const content = [...mixinFiles.values()][0]
    expect(content).toContain("PaginationArguments")

    // The registry built from these files should include the mixin
    const registry = parseMixinRegistry(mixinFiles)
    expect(registry.has("CircusApp::PaginationArguments")).toBe(true)
    const args = registry.get("CircusApp::PaginationArguments")!
    expect(args.map(a => a.name)).toContain("page")
    expect(args.map(a => a.name)).toContain("perPage")
  })

  it("should find mixin files in nested lib subdirectory matching component layout", () => {
    // Simulate: components/circus_app/lib/circus_app/concerns/pagination_arguments.rb
    const nestedLibDir = path.join(
      tmpDir,
      "components",
      "circus_app",
      "lib",
      "circus_app",
      "concerns"
    )
    fs.mkdirSync(nestedLibDir, { recursive: true })

    fs.writeFileSync(
      path.join(nestedLibDir, "pagination_arguments.rb"),
      `
module CircusApp
  module PaginationArguments
    def self.included(cls)
      cls.class_eval do
        argument :page, Integer, required: false, default_value: 1
      end
    end
  end
end
`
    )

    const mixinFiles = loadMixinFiles(tmpDir)
    expect(mixinFiles.size).toBe(1)

    const registry = parseMixinRegistry(mixinFiles)
    expect(registry.has("CircusApp::PaginationArguments")).toBe(true)
  })
})

describe("parseResolverDefinition with mixin arguments", () => {
  const PAGINATION_MIXIN_ARGS = [
    {
      name: "page",
      type: "Int",
      required: false,
      isList: false,
      listDepth: 0,
      defaultValue: "1",
    },
    {
      name: "perPage",
      type: "Int",
      required: false,
      isList: false,
      listDepth: 0,
      defaultValue: "100",
    },
  ]

  it("should merge arguments from included mixin modules", () => {
    const mixinRegistry = new Map([
      ["CircusApp::PaginationArguments", PAGINATION_MIXIN_ARGS],
    ])

    const resolver = parseResolverDefinition(
      `
module BigTop
  module Graphql
    class CircusCatchphrasesQuery < CircusApp::BaseQuery
      include CircusApp::PaginationArguments

      description "Library of circus catchphrases."

      type ::BigTop::Graphql::CircusCatchphraseResults, null: false

      def resolve(per_page:, page:)
      end
    end
  end
end
`,
      "big_top/circus_catchphrases_query.rb",
      mixinRegistry
    )

    expect(resolver).not.toBeNull()

    const argNames = resolver!.arguments.map(a => a.name)
    expect(argNames).toContain("page")
    expect(argNames).toContain("perPage")
  })

  it("should not duplicate arguments already declared on the resolver", () => {
    const mixinRegistry = new Map([
      ["CircusApp::PaginationArguments", PAGINATION_MIXIN_ARGS],
    ])

    const resolver = parseResolverDefinition(
      `
module Foo
  module Graphql
    class MyQuery < CircusApp::BaseQuery
      include CircusApp::PaginationArguments

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
module CircusApp
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
module BigTop
  module Graphql
    class CircusCatchphraseResults < CircusApp::Types::BaseObject
      graphql_name "CircusCatchphraseResults"
      field :list, [String]
      field :page, Int
      field :per_page, Int
    end
  end
end
`,
      "big_top/circus_catchphrase_results.rb"
    )!

    const resolver = parseResolverDefinition(
      `
module BigTop
  module Graphql
    class CircusCatchphrasesQuery < CircusApp::BaseQuery
      include CircusApp::PaginationArguments

      type ::BigTop::Graphql::CircusCatchphraseResults, null: false

      def resolve(per_page:, page:); end
    end
  end
end
`,
      "big_top/circus_catchphrases_query.rb",
      mixinRegistry
    )!

    const registrations: ResolverRegistration[] = [
      {
        fieldName: "circusCatchphrases",
        resolverClassName: "BigTop::Graphql::CircusCatchphrasesQuery",
        target: "query",
      },
    ]

    const schema = buildGraphQLSchema([resultsType], [resolver], registrations)

    const queryType = schema.getQueryType()!
    const field = queryType.getFields()["circusCatchphrases"]
    expect(field).toBeDefined()

    const argNames = field.args.map((a: any) => a.name)
    expect(argNames).toContain("page")
    expect(argNames).toContain("perPage")
  })
})

// ── Dynamic field block detection & resolution ─────────────────────────────────

describe("detectDynamicFieldBlocks", () => {
  it("detects a simple .each block with a bare variable field", () => {
    const content = `
      class RowType < CircusApp::Types::BaseObject
        field :id, ID
        SomeAggregate.counter_columns.each do |column|
          field column, Integer
        end
      end
    `
    const blocks = detectDynamicFieldBlocks(content)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].className).toBe("SomeAggregate")
    expect(blocks[0].methodName).toBe("counter_columns")
    expect(blocks[0].useKeys).toBe(false)
    expect(blocks[0].blockVar).toBe("column")
    expect(blocks[0].patterns).toHaveLength(1)
    expect(blocks[0].patterns[0]).toEqual({ suffix: "", type: "Int" })
  })

  it("detects block with interpolated suffix field", () => {
    const content = `
      class RowType < CircusApp::Types::BaseObject
        SomeClass.fraction_columns.keys.each do |column|
          field :"#{column}_percentage", Float
        end
      end
    `
    const blocks = detectDynamicFieldBlocks(content)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].useKeys).toBe(true)
    expect(blocks[0].patterns).toHaveLength(1)
    expect(blocks[0].patterns[0]).toEqual({
      suffix: "_percentage",
      type: "Float",
    })
  })

  it("detects multiple field patterns in one block", () => {
    const content = `
      class RowType < CircusApp::Types::BaseObject
        SomeAggregate.counter_columns.each do |column|
          field column, Integer
          define_method(column) do
            object[column]
          end
          field :"#{column}_average", Float
          define_method(:"#{column}_average") do
            object[:"#{column}_average"]
          end
        end
      end
    `
    const blocks = detectDynamicFieldBlocks(content)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].patterns).toHaveLength(2)
    const suffixes = blocks[0].patterns.map(p => p.suffix)
    expect(suffixes).toContain("")
    expect(suffixes).toContain("_average")
    const types = blocks[0].patterns.map(p => p.type)
    expect(types).toContain("Int")
    expect(types).toContain("Float")
  })

  it("detects multiple .each blocks in one class", () => {
    const content = `
      class RowType < CircusApp::Types::BaseObject
        TroupeStats.counter_columns.each do |column|
          field column, Integer
        end
        TroupeStats::Show.ratio_columns.keys.each do |column|
          field :"#{column}_percentage", Float
        end
      end
    `
    const blocks = detectDynamicFieldBlocks(content)
    expect(blocks).toHaveLength(2)
    expect(blocks[0].methodName).toBe("counter_columns")
    expect(blocks[0].useKeys).toBe(false)
    expect(blocks[1].methodName).toBe("ratio_columns")
    expect(blocks[1].useKeys).toBe(true)
  })

  it("is attached to the type definition via parseRubyTypeDefinition", () => {
    const content = `
      class RowType < CircusApp::Types::BaseObject
        field :id, ID
        SomeAggregate.counter_columns.each do |column|
          field column, Integer
        end
      end
    `
    const typeDef = parseRubyTypeDefinition(content, "row_type.rb")!
    expect(typeDef).toBeDefined()
    expect(typeDef.dynamicFieldBlocks).toBeDefined()
    expect(typeDef.dynamicFieldBlocks).toHaveLength(1)
    // Static fields still present
    expect(typeDef.fields.find(f => f.name === "id")).toBeDefined()
  })

  it("detects inline symbol array with .each", () => {
    const content = `
      class RowType < CircusApp::Types::BaseObject
        %i[acts opening_bookings closing_bookings].each do |column|
          field column, Int
          field :"#{column}_projection", Float
        end
      end
    `
    const blocks = detectDynamicFieldBlocks(content)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].inlineValues).toEqual([
      "acts",
      "opening_bookings",
      "closing_bookings",
    ])
    expect(blocks[0].className).toBeUndefined()
    expect(blocks[0].methodName).toBeUndefined()
    expect(blocks[0].patterns).toHaveLength(2)
  })

  it("detects multiple inline arrays and method calls mixed", () => {
    const content = `
      class RowType < CircusApp::Types::BaseObject
        %i[field1 field2].each do |col|
          field col, String
        end
        SomeClass.method_name.each do |col|
          field col, Integer
        end
      end
    `
    const blocks = detectDynamicFieldBlocks(content)
    expect(blocks).toHaveLength(2)
    expect(blocks[0].inlineValues).toEqual(["field1", "field2"])
    expect(blocks[1].className).toBe("SomeClass")
    expect(blocks[1].methodName).toBe("method_name")
  })
})

describe("resolveDynamicFields", () => {
  it("resolves fields from %i[...] symbol array in same-file content", () => {
    const typeContent = `
      class RowType < CircusApp::Types::BaseObject
        field :id, ID
        SomeAggregate.counter_columns.each do |column|
          field column, Integer
        end
      end

      class SomeAggregate
        def self.counter_columns
          %i[
            tents_visited
            ringmasters_met
            intel_gathered
          ]
        end
      end
    `
    const typeDef = parseRubyTypeDefinition(typeContent, "row_type.rb")!
    const files = new Map([["row_type.rb", typeContent]])
    resolveDynamicFields([typeDef], files, "/tmp")

    const fieldNames = typeDef.fields.map(f => f.name)
    expect(fieldNames).toContain("tentsVisited")
    expect(fieldNames).toContain("ringmastersMet")
    expect(fieldNames).toContain("intelGathered")

    const tentsField = typeDef.fields.find(f => f.name === "tentsVisited")!
    expect(tentsField.type).toBe("Int")
  })

  it("resolves fields with suffix from hash keys in same-file content", () => {
    const typeContent = `
      class RowType < CircusApp::Types::BaseObject
        TroupeStats::Show.ratio_columns.keys.each do |column|
          field :"#{column}_percentage", Float
        end
      end

      class TroupeStats
        class Show
          def self.ratio_columns
            {
              ringmasters_met: :tents_visited,
              intel_gathered: :ringmasters_met,
              bookings_made: :ringmasters_met,
            }
          end
        end
      end
    `
    const typeDef = parseRubyTypeDefinition(typeContent, "row_type.rb")!
    const files = new Map([["row_type.rb", typeContent]])
    resolveDynamicFields([typeDef], files, "/tmp")

    const fieldNames = typeDef.fields.map(f => f.name)
    expect(fieldNames).toContain("ringmastersMetPercentage")
    expect(fieldNames).toContain("intelGatheredPercentage")
    expect(fieldNames).toContain("bookingsMadePercentage")

    const pct = typeDef.fields.find(f => f.name === "ringmastersMetPercentage")!
    expect(pct.type).toBe("Float")
  })

  it("resolves fields from multiple patterns in the same block", () => {
    const typeContent = `
      class RowType < CircusApp::Types::BaseObject
        SomeAggregate.counter_columns.each do |column|
          field column, Integer
          define_method(column) do
            object[column]
          end
          field :"#{column}_average", Float
          define_method(:"#{column}_average") do
            object[:"#{column}_average"]
          end
        end
      end

      class SomeAggregate
        def self.counter_columns
          %i[tents_visited ringmasters_met]
        end
      end
    `
    const typeDef = parseRubyTypeDefinition(typeContent, "row_type.rb")!
    const files = new Map([["row_type.rb", typeContent]])
    resolveDynamicFields([typeDef], files, "/tmp")

    const fieldNames = typeDef.fields.map(f => f.name)
    // Integer fields (no suffix)
    expect(fieldNames).toContain("tentsVisited")
    expect(fieldNames).toContain("ringmastersMet")
    // Float fields with _average suffix
    expect(fieldNames).toContain("tentsVisitedAverage")
    expect(fieldNames).toContain("ringmastersMetAverage")

    expect(typeDef.fields.find(f => f.name === "tentsVisited")?.type).toBe(
      "Int"
    )
    expect(
      typeDef.fields.find(f => f.name === "tentsVisitedAverage")?.type
    ).toBe("Float")
  })

  it("resolves fields from a separate file in the provided files map", () => {
    const typeContent = `
      class RowType < CircusApp::Types::BaseObject
        OutsideRecord.show_data.each do |col|
          field col, Integer
        end
      end
    `
    const modelContent = `
      class OutsideRecord
        def self.show_data
          %i[auditions applause enrollments]
        end
      end
    `
    const typeDef = parseRubyTypeDefinition(typeContent, "row_type.rb")!
    // Both files in the map — simulates them being loaded together
    const files = new Map([
      ["row_type.rb", typeContent],
      ["outside_record.rb", modelContent],
    ])
    resolveDynamicFields([typeDef], files, "/tmp")

    const fieldNames = typeDef.fields.map(f => f.name)
    expect(fieldNames).toContain("auditions")
    expect(fieldNames).toContain("applause")
    expect(fieldNames).toContain("enrollments")
  })

  it("does not duplicate fields that are already declared statically", () => {
    const typeContent = `
      class RowType < CircusApp::Types::BaseObject
        field :tents_visited, Integer
        SomeAggregate.counter_columns.each do |column|
          field column, Integer
        end
      end

      class SomeAggregate
        def self.counter_columns
          %i[tents_visited ringmasters_met]
        end
      end
    `
    const typeDef = parseRubyTypeDefinition(typeContent, "row_type.rb")!
    const files = new Map([["row_type.rb", typeContent]])
    resolveDynamicFields([typeDef], files, "/tmp")

    const tentsFields = typeDef.fields.filter(f => f.name === "tentsVisited")
    expect(tentsFields).toHaveLength(1) // Not duplicated
    expect(typeDef.fields.find(f => f.name === "ringmastersMet")).toBeDefined()
  })

  it("resolves nested class methods from hash keys with suffix (cross-file scenario)", () => {
    const typeContent = `
      class TroupeMetricsRowType < CircusApp::Types::BaseObject
        field :id, ID
        AudienceGrowthTroupeStatsAggregate::Row.ratio_columns.keys.each do |column|
          field :"#{column}_percentage", Float
          define_method(:"#{column}_percentage") do
            object[:"#{column}_percentage"]
          end
        end
      end
    `
    const modelContent = `
      class AudienceGrowthTroupeStatsAggregate < ApplicationRecord
        class Row
          def self.ratio_columns
            {
              ringmasters_met: :tents_visited,
              intel_gathered: :ringmasters_met,
              easy_crowds: :ringmasters_met,
              bookings_made: :ringmasters_met,
            }
          end
        end
      end
    `
    const typeDef = parseRubyTypeDefinition(
      typeContent,
      "troupe_metrics_row_type.rb"
    )!
    const files = new Map([
      ["troupe_metrics_row_type.rb", typeContent],
      ["audience_growth_troupe_stats_aggregate.rb", modelContent],
    ])
    resolveDynamicFields([typeDef], files, "/tmp")

    const fieldNames = typeDef.fields.map(f => f.name)
    expect(fieldNames).toContain("ringmastersMetPercentage")
    expect(fieldNames).toContain("intelGatheredPercentage")
    expect(fieldNames).toContain("easyCrowdsPercentage")
    expect(fieldNames).toContain("bookingsMadePercentage")

    // Verify they're Float type with _percentage suffix
    const decisionField = typeDef.fields.find(
      f => f.name === "ringmastersMetPercentage"
    )!
    expect(decisionField.type).toBe("Float")
  })

  it("resolves inline symbol array with suffix pattern", () => {
    const typeContent = `
      class RowType < CircusApp::Types::BaseObject
        %i[acts opening_bookings closing_bookings previews].each do |column|
          field column.to_sym, Int
          field :"#{column}_projection", Float
        end
      end
    `
    const typeDef = parseRubyTypeDefinition(typeContent, "row_type.rb")!
    const files = new Map([["row_type.rb", typeContent]])
    resolveDynamicFields([typeDef], files, "/tmp")

    const fieldNames = typeDef.fields.map(f => f.name)
    // Base fields (bare column names)
    expect(fieldNames).toContain("acts")
    expect(fieldNames).toContain("openingBookings")
    expect(fieldNames).toContain("closingBookings")
    expect(fieldNames).toContain("previews")
    // Projection fields (with _projection suffix)
    expect(fieldNames).toContain("actsProjection")
    expect(fieldNames).toContain("openingBookingsProjection")
    expect(fieldNames).toContain("closingBookingsProjection")
    expect(fieldNames).toContain("previewsProjection")

    // Verify types
    const actsField = typeDef.fields.find(f => f.name === "acts")!
    expect(actsField.type).toBe("Int")
    const actsProjectionField = typeDef.fields.find(
      f => f.name === "actsProjection"
    )!
    expect(actsProjectionField.type).toBe("Float")
  })
})
