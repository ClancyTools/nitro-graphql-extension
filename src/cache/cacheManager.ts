import * as fs from "fs"
import * as path from "path"
import * as os from "os"

export interface CacheEntry<T> {
  data: T
  timestamp: number
}

export class CacheManager {
  private cacheDir: string
  private memoryCache: Map<string, CacheEntry<unknown>> = new Map()
  private maxMemoryEntries: number

  constructor(maxMemoryEntries = 200) {
    this.cacheDir = path.join(os.homedir(), ".cache", "nitro-graphql-validator")
    this.maxMemoryEntries = maxMemoryEntries
    this.ensureCacheDir()
  }

  private ensureCacheDir(): void {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true })
    } catch {
      // Directory may already exist
    }
  }

  getCacheDir(): string {
    return this.cacheDir
  }

  async readDisk<T>(key: string): Promise<CacheEntry<T> | null> {
    const filePath = path.join(this.cacheDir, `${key}.json`)
    try {
      const raw = fs.readFileSync(filePath, "utf-8")
      const entry = JSON.parse(raw) as CacheEntry<T>
      return entry
    } catch {
      return null
    }
  }

  async writeDisk<T>(key: string, data: T): Promise<void> {
    this.ensureCacheDir()
    const filePath = path.join(this.cacheDir, `${key}.json`)
    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
    }
    fs.writeFileSync(filePath, JSON.stringify(entry), "utf-8")
  }

  async removeDisk(key: string): Promise<void> {
    const filePath = path.join(this.cacheDir, `${key}.json`)
    try {
      fs.unlinkSync(filePath)
    } catch {
      // File may not exist
    }
  }

  getMemory<T>(key: string): T | undefined {
    const entry = this.memoryCache.get(key)
    if (entry) {
      return entry.data as T
    }
    return undefined
  }

  setMemory<T>(key: string, data: T): void {
    // LRU eviction: remove oldest entry if at capacity
    if (
      this.memoryCache.size >= this.maxMemoryEntries &&
      !this.memoryCache.has(key)
    ) {
      const firstKey = this.memoryCache.keys().next().value
      if (firstKey !== undefined) {
        this.memoryCache.delete(firstKey)
      }
    }
    this.memoryCache.set(key, { data, timestamp: Date.now() })
  }

  hasMemory(key: string): boolean {
    return this.memoryCache.has(key)
  }

  clearMemory(): void {
    this.memoryCache.clear()
  }

  async clearAll(): Promise<void> {
    this.clearMemory()
    try {
      const files = fs.readdirSync(this.cacheDir)
      for (const file of files) {
        fs.unlinkSync(path.join(this.cacheDir, file))
      }
    } catch {
      // Cache dir may not exist
    }
  }

  get memorySize(): number {
    return this.memoryCache.size
  }
}
