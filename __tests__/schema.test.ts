import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { CacheManager } from "../src/cache/cacheManager"

describe("CacheManager", () => {
  let cache: CacheManager
  let testDir: string

  beforeEach(() => {
    cache = new CacheManager(10)
    testDir = cache.getCacheDir()
  })

  afterEach(async () => {
    await cache.clearAll()
  })

  describe("memory cache", () => {
    it("should store and retrieve values", () => {
      cache.setMemory("key1", { foo: "bar" })
      expect(cache.getMemory("key1")).toEqual({ foo: "bar" })
    })

    it("should return undefined for missing keys", () => {
      expect(cache.getMemory("nonexistent")).toBeUndefined()
    })

    it("should report hasMemory correctly", () => {
      expect(cache.hasMemory("key1")).toBe(false)
      cache.setMemory("key1", "value")
      expect(cache.hasMemory("key1")).toBe(true)
    })

    it("should clear memory cache", () => {
      cache.setMemory("key1", "value1")
      cache.setMemory("key2", "value2")
      cache.clearMemory()
      expect(cache.memorySize).toBe(0)
    })

    it("should evict oldest entry when at capacity", () => {
      // Cache capacity is 10
      for (let i = 0; i < 10; i++) {
        cache.setMemory(`key${i}`, `value${i}`)
      }
      expect(cache.memorySize).toBe(10)

      // Adding one more should evict the first
      cache.setMemory("key10", "value10")
      expect(cache.memorySize).toBe(10)
      expect(cache.hasMemory("key0")).toBe(false)
      expect(cache.hasMemory("key10")).toBe(true)
    })

    it("should not evict when updating existing key", () => {
      for (let i = 0; i < 10; i++) {
        cache.setMemory(`key${i}`, `value${i}`)
      }
      cache.setMemory("key0", "updated")
      expect(cache.memorySize).toBe(10)
      expect(cache.getMemory("key0")).toBe("updated")
    })
  })

  describe("disk cache", () => {
    it("should write and read from disk", async () => {
      await cache.writeDisk("test-key", { hello: "world" })
      const entry = await cache.readDisk<{ hello: string }>("test-key")
      expect(entry).not.toBeNull()
      expect(entry!.data).toEqual({ hello: "world" })
      expect(entry!.timestamp).toBeGreaterThan(0)
    })

    it("should return null for missing disk keys", async () => {
      const entry = await cache.readDisk("missing")
      expect(entry).toBeNull()
    })

    it("should remove disk entries", async () => {
      await cache.writeDisk("to-remove", "data")
      await cache.removeDisk("to-remove")
      const entry = await cache.readDisk("to-remove")
      expect(entry).toBeNull()
    })

    it("should handle removing non-existent disk entries", async () => {
      await expect(cache.removeDisk("nonexistent")).resolves.toBeUndefined()
    })
  })

  describe("clearAll", () => {
    it("should clear both memory and disk caches", async () => {
      cache.setMemory("mem-key", "mem-value")
      await cache.writeDisk("disk-key", "disk-value")

      await cache.clearAll()

      expect(cache.memorySize).toBe(0)
      const entry = await cache.readDisk("disk-key")
      expect(entry).toBeNull()
    })
  })
})
