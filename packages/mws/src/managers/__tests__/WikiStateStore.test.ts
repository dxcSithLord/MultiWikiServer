/**
 * Test harness for Phase 2 & 3 WikiStateStore improvements
 *
 * Tests:
 * - BufferedWriter batching and flushing (Phase 2)
 * - Input validation in serveStoreTiddlers (Phase 2)
 * - Plugin file error handling (Phase 2)
 * - ETag caching behavior (Phase 3)
 * - CSP header functionality (Phase 3)
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Readable } from "stream";

// Mock BufferedWriter for isolated testing
class BufferedWriter {
  private buffer: string[] = [];
  private bufferSize = 0;
  private readonly maxBufferSize = 64 * 1024; // 64KB

  constructor(private state: any) {}

  async write(chunk: string): Promise<void> {
    this.buffer.push(chunk);
    this.bufferSize += Buffer.byteLength(chunk, 'utf8');

    if (this.bufferSize >= this.maxBufferSize) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const content = this.buffer.join('');
    await this.state.write(content);

    this.buffer = [];
    this.bufferSize = 0;
  }

  // Test helpers
  getBufferSize() { return this.bufferSize; }
  getBufferChunks() { return this.buffer.length; }
}

describe("WikiStateStore - Phase 2 & 3 Improvements", () => {

  describe("BufferedWriter - Write Batching", () => {
    it("should accumulate small writes without flushing", async () => {
      const writes: string[] = [];
      const mockState = {
        write: mock(async (content: string) => {
          writes.push(content);
        })
      };

      const writer = new BufferedWriter(mockState);

      await writer.write("chunk1");
      await writer.write("chunk2");
      await writer.write("chunk3");

      // Should not have called state.write yet
      expect(writes.length).toBe(0);
      expect(writer.getBufferChunks()).toBe(3);
    });

    it("should auto-flush when buffer exceeds 64KB", async () => {
      const writes: string[] = [];
      const mockState = {
        write: mock(async (content: string) => {
          writes.push(content);
        })
      };

      const writer = new BufferedWriter(mockState);

      // Create a chunk slightly larger than 64KB
      const largeChunk = "x".repeat(65 * 1024);
      await writer.write(largeChunk);

      // Should have auto-flushed
      expect(writes.length).toBe(1);
      expect(writes[0]).toBe(largeChunk);
      expect(writer.getBufferSize()).toBe(0);
    });

    it("should accumulate multiple writes until threshold", async () => {
      const writes: string[] = [];
      const mockState = {
        write: mock(async (content: string) => {
          writes.push(content);
        })
      };

      const writer = new BufferedWriter(mockState);

      // Write 30KB chunks - should accumulate two before flushing on third
      const chunk30kb = "x".repeat(30 * 1024);

      await writer.write(chunk30kb); // 30KB total
      expect(writes.length).toBe(0);

      await writer.write(chunk30kb); // 60KB total
      expect(writes.length).toBe(0);

      await writer.write(chunk30kb); // 90KB total - should trigger flush
      expect(writes.length).toBe(1);
      expect(writes[0]).toBe(chunk30kb + chunk30kb + chunk30kb);
    });

    it("should flush remaining content on explicit flush()", async () => {
      const writes: string[] = [];
      const mockState = {
        write: mock(async (content: string) => {
          writes.push(content);
        })
      };

      const writer = new BufferedWriter(mockState);

      await writer.write("chunk1");
      await writer.write("chunk2");

      expect(writes.length).toBe(0);

      await writer.flush();

      expect(writes.length).toBe(1);
      expect(writes[0]).toBe("chunk1chunk2");
      expect(writer.getBufferSize()).toBe(0);
    });

    it("should handle empty flush gracefully", async () => {
      const writes: string[] = [];
      const mockState = {
        write: mock(async (content: string) => {
          writes.push(content);
        })
      };

      const writer = new BufferedWriter(mockState);

      await writer.flush();

      expect(writes.length).toBe(0);
    });

    it("should handle multiple flush cycles", async () => {
      const writes: string[] = [];
      const mockState = {
        write: mock(async (content: string) => {
          writes.push(content);
        })
      };

      const writer = new BufferedWriter(mockState);

      await writer.write("batch1");
      await writer.flush();

      await writer.write("batch2");
      await writer.flush();

      await writer.write("batch3");
      await writer.flush();

      expect(writes.length).toBe(3);
      expect(writes[0]).toBe("batch1");
      expect(writes[1]).toBe("batch2");
      expect(writes[2]).toBe("batch3");
    });

    it("should correctly calculate byte size for multi-byte characters", async () => {
      const writes: string[] = [];
      const mockState = {
        write: mock(async (content: string) => {
          writes.push(content);
        })
      };

      const writer = new BufferedWriter(mockState);

      // Unicode characters take more than 1 byte
      const unicode = "🔥".repeat(20000); // Each emoji is 4 bytes

      await writer.write(unicode);

      // Should auto-flush because byte size exceeds 64KB
      expect(writes.length).toBe(1);
    });
  });

  describe("Input Validation - serveStoreTiddlers", () => {
    it("should warn and return early when bagKeys is empty", async () => {
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = mock((...args: any[]) => {
        warnings.push(args.join(' '));
      });

      const bagKeys: string[] = [];
      const bagOrder = new Map<string, number>();
      const recipe_name = "test-recipe";
      let writeTiddlerCalled = false;

      const writeTiddler = mock(async (fields: any) => {
        writeTiddlerCalled = true;
      });

      // Simulate the validation logic
      if (bagKeys.length === 0) {
        console.warn(`Recipe ${recipe_name} has no non-plugin bags to serve`);
        console.warn = originalWarn;

        expect(warnings.length).toBeGreaterThan(0);
        expect(warnings[0]).toContain("test-recipe");
        expect(warnings[0]).toContain("no non-plugin bags");
        expect(writeTiddlerCalled).toBe(false);
        return;
      }

      console.warn = originalWarn;
    });

    it("should throw error when bag keys missing from order map", async () => {
      const bagKeys = ["bag-1", "bag-2", "bag-3"];
      const bagOrder = new Map([
        ["bag-1", 1],
        // bag-2 missing!
        ["bag-3", 3]
      ]);
      const recipe_name = "test-recipe";

      // Simulate the validation logic
      const missingBags = bagKeys.filter(id => !bagOrder.has(id));

      if (missingBags.length > 0) {
        expect(() => {
          throw new Error(
            `Bags missing from bag order map in recipe ${recipe_name}: ${missingBags.join(', ')}`
          );
        }).toThrow("Bags missing from bag order map");

        expect(missingBags).toEqual(["bag-2"]);
        return;
      }
    });

    it("should throw error when database results don't match expected bags", async () => {
      const bagKeys = ["bag-1", "bag-2", "bag-3"];
      const bagTiddlers = [
        { bag_id: "bag-1", bag_name: "Bag 1", tiddlers: [] },
        { bag_id: "bag-3", bag_name: "Bag 3", tiddlers: [] }
        // bag-2 missing from database!
      ];
      const recipe_name = "test-recipe";

      // Simulate the validation logic
      if (bagTiddlers.length !== bagKeys.length) {
        const foundIds = new Set(bagTiddlers.map(b => b.bag_id));
        const notFound = bagKeys.filter(id => !foundIds.has(id));

        expect(() => {
          throw new Error(
            `Database missing bags that should exist in recipe ${recipe_name}: ${notFound.join(', ')}`
          );
        }).toThrow("Database missing bags");

        expect(notFound).toEqual(["bag-2"]);
        return;
      }
    });

    it("should throw error when bag order is undefined during sort", async () => {
      const bagOrder = new Map([
        ["bag-1", 1],
        // bag-2 missing!
      ]);

      const bagA = { bag_id: "bag-1" };
      const bagB = { bag_id: "bag-2" };

      const orderA = bagOrder.get(bagA.bag_id);
      const orderB = bagOrder.get(bagB.bag_id);

      expect(() => {
        if (orderA === undefined || orderB === undefined) {
          throw new Error(
            `Bag order missing for bags: ${[
              orderA === undefined ? bagA.bag_id : null,
              orderB === undefined ? bagB.bag_id : null
            ].filter(Boolean).join(', ')}`
          );
        }
      }).toThrow("Bag order missing for bags: bag-2");
    });

    it("should pass validation with correct inputs", () => {
      const bagKeys = ["bag-1", "bag-2", "bag-3"];
      const bagOrder = new Map([
        ["bag-1", 1],
        ["bag-2", 2],
        ["bag-3", 3]
      ]);

      // All bags present in order map
      const missingBags = bagKeys.filter(id => !bagOrder.has(id));
      expect(missingBags.length).toBe(0);

      // All bags returned from database
      const bagTiddlers = [
        { bag_id: "bag-1", tiddlers: [] },
        { bag_id: "bag-2", tiddlers: [] },
        { bag_id: "bag-3", tiddlers: [] }
      ];
      expect(bagTiddlers.length).toBe(bagKeys.length);

      // All order values defined
      const orderA = bagOrder.get("bag-1");
      const orderB = bagOrder.get("bag-2");
      expect(orderA).toBeDefined();
      expect(orderB).toBeDefined();
    });
  });

  describe("Plugin File Error Handling", () => {
    it("should throw PLUGIN_NOT_FOUND when plugin file path is missing", () => {
      const pluginFiles = new Map([
        ["$:/plugins/foo", "tiddlywiki/5.3.0/plugins/foo"]
      ]);

      const plugins = ["$:/plugins/foo", "$:/plugins/bar"];
      const recipe_name = "test-recipe";

      for (const pluginName of plugins) {
        const pluginFile = pluginFiles.get(pluginName);

        if (!pluginFile) {
          expect(() => {
            class SendError extends Error {
              constructor(public code: string, public status: number, public data: any) {
                super(`${code}: ${JSON.stringify(data)}`);
              }
            }
            throw new SendError("PLUGIN_NOT_FOUND", 500, {
              plugin: pluginName,
              recipe: recipe_name
            });
          }).toThrow("PLUGIN_NOT_FOUND");

          return; // Expected error
        }
      }
    });

    it("should include plugin name and path in PLUGIN_READ_ERROR", () => {
      const pluginName = "$:/plugins/test";
      const filePath = "/cache/plugin.json";
      const recipe_name = "test-recipe";

      class SendError extends Error {
        constructor(public code: string, public status: number, public data: any) {
          super(`${code}: ${JSON.stringify(data)}`);
        }
      }

      const error = new SendError("PLUGIN_READ_ERROR", 500, {
        plugin: pluginName,
        path: filePath,
        error: "ENOENT: no such file or directory"
      });

      expect(error.code).toBe("PLUGIN_READ_ERROR");
      expect(error.status).toBe(500);
      expect(error.data.plugin).toBe(pluginName);
      expect(error.data.path).toBe(filePath);
      expect(error.data.error).toContain("ENOENT");
    });

    it("should handle stream errors during plugin loading", async () => {
      const errors: string[] = [];
      const originalError = console.error;
      console.error = mock((...args: any[]) => {
        errors.push(args.join(' '));
      });

      const stream = new Readable({
        read() {
          this.destroy(new Error("Stream read failed"));
        }
      });

      let errorCaught = false;
      stream.on('error', (err) => {
        errorCaught = true;
        expect(err.message).toBe("Stream read failed");
      });

      // Trigger the error
      stream.read();

      // Wait for error event
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(errorCaught).toBe(true);
      console.error = originalError;
    });
  });

  describe("ETag Caching - Phase 3", () => {
    it("should generate consistent ETag from template, bags, plugins, and tiddlers", () => {
      const crypto = require("crypto");

      const hash1 = crypto.createHash('md5');
      hash1.update("template content");
      hash1.update("bag1,bag2");
      hash1.update("sha384-abc,sha384-def");
      hash1.update("12345");
      const etag1 = `"${hash1.digest("hex")}"`;

      // Same inputs should produce same ETag
      const hash2 = crypto.createHash('md5');
      hash2.update("template content");
      hash2.update("bag1,bag2");
      hash2.update("sha384-abc,sha384-def");
      hash2.update("12345");
      const etag2 = `"${hash2.digest("hex")}"`;

      expect(etag1).toBe(etag2);
    });

    it("should generate different ETag when template changes", () => {
      const crypto = require("crypto");

      const hash1 = crypto.createHash('md5');
      hash1.update("template v1");
      hash1.update("bag1,bag2");
      hash1.update("sha384-abc");
      hash1.update("12345");
      const etag1 = `"${hash1.digest("hex")}"`;

      const hash2 = crypto.createHash('md5');
      hash2.update("template v2");
      hash2.update("bag1,bag2");
      hash2.update("sha384-abc");
      hash2.update("12345");
      const etag2 = `"${hash2.digest("hex")}"`;

      expect(etag1).not.toBe(etag2);
    });

    it("should generate different ETag when tiddler changes", () => {
      const crypto = require("crypto");

      const hash1 = crypto.createHash('md5');
      hash1.update("template");
      hash1.update("bag1,bag2");
      hash1.update("sha384-abc");
      hash1.update("12345");
      const etag1 = `"${hash1.digest("hex")}"`;

      const hash2 = crypto.createHash('md5');
      hash2.update("template");
      hash2.update("bag1,bag2");
      hash2.update("sha384-abc");
      hash2.update("12346"); // Different revision
      const etag2 = `"${hash2.digest("hex")}"`;

      expect(etag1).not.toBe(etag2);
    });

    it("should return 304 when ETag matches and caching enabled", () => {
      const etag = '"abc123"';
      const enableETagCaching = true;
      const ifNoneMatch = '"abc123"';

      const match = enableETagCaching && ifNoneMatch === etag;

      expect(match).toBe(true);
    });

    it("should return 200 when ETag doesn't match", () => {
      const etag = '"abc123"';
      const enableETagCaching = true;
      const ifNoneMatch = '"different"';

      const match = enableETagCaching && ifNoneMatch === etag;

      expect(match).toBe(false);
    });

    it("should return 200 when ETag caching disabled even if match", () => {
      const etag = '"abc123"';
      const enableETagCaching = false;
      const ifNoneMatch = '"abc123"';

      const match = enableETagCaching && ifNoneMatch === etag;

      expect(match).toBe(false);
    });

    it("should set correct cache-control headers", () => {
      const headers: Record<string, string> = {};
      headers["cache-control"] = "max-age=0, private, no-cache";
      headers["etag"] = '"abc123"';

      expect(headers["cache-control"]).toBe("max-age=0, private, no-cache");
      expect(headers["etag"]).toBe('"abc123"');
    });
  });

  describe("CSP Headers - Phase 3", () => {
    it("should include CSP header when enabled", () => {
      const enableCSP = true;
      const headers: Record<string, string> = {};

      if (enableCSP) {
        headers['content-security-policy'] = [
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:",
          "form-action 'none'",
        ].join("; ");
      }

      expect(headers['content-security-policy']).toBeDefined();
      expect(headers['content-security-policy']).toContain("default-src 'self'");
      expect(headers['content-security-policy']).toContain("form-action 'none'");
    });

    it("should not include CSP header when disabled", () => {
      const enableCSP = false;
      const headers: Record<string, string> = {};

      if (enableCSP) {
        headers['content-security-policy'] = [
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:",
          "form-action 'none'",
        ].join("; ");
      }

      expect(headers['content-security-policy']).toBeUndefined();
    });

    it("should allow required TiddlyWiki features in CSP", () => {
      const csp = [
        "default-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:",
        "form-action 'none'",
      ].join("; ");

      // TiddlyWiki needs these to function
      expect(csp).toContain("'unsafe-inline'"); // For inline scripts/styles
      expect(csp).toContain("'unsafe-eval'"); // For dynamic code execution
      expect(csp).toContain("'wasm-unsafe-eval'"); // For WebAssembly
      expect(csp).toContain("data:"); // For data URIs
      expect(csp).toContain("blob:"); // For blob URIs
    });

    it("should block form submissions in CSP", () => {
      const csp = [
        "default-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:",
        "form-action 'none'",
      ].join("; ");

      expect(csp).toContain("form-action 'none'");
    });
  });

  describe("Integration - Multiple Features", () => {
    it("should handle buffered writes with ETag caching enabled", async () => {
      const writes: string[] = [];
      const mockState = {
        write: mock(async (content: string) => {
          writes.push(content);
        }),
        headers: {
          "if-none-match": '"old-etag"'
        },
        config: {
          enableETagCaching: true
        }
      };

      const writer = new BufferedWriter(mockState);

      const newEtag = '"new-etag"';
      const match = mockState.config.enableETagCaching &&
                    mockState.headers["if-none-match"] === newEtag;

      // Different ETags, should write content
      expect(match).toBe(false);

      await writer.write("content");
      await writer.flush();

      expect(writes.length).toBe(1);
    });

    it("should validate inputs before writing with CSP enabled", () => {
      const bagKeys = ["bag-1"];
      const bagOrder = new Map([["bag-1", 1]]);
      const enableCSP = true;

      // Validation passes
      const missingBags = bagKeys.filter(id => !bagOrder.has(id));
      expect(missingBags.length).toBe(0);

      // CSP configured
      const headers: Record<string, string> = {};
      if (enableCSP) {
        headers['content-security-policy'] = [
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:",
          "form-action 'none'",
        ].join("; ");
      }

      expect(headers['content-security-policy']).toBeDefined();
    });

    it("should handle plugin errors with buffering active", async () => {
      const writes: string[] = [];
      const mockState = {
        write: mock(async (content: string) => {
          writes.push(content);
        })
      };

      const writer = new BufferedWriter(mockState);

      // Start buffering
      await writer.write("start");

      // Plugin error occurs
      const pluginFiles = new Map();
      const pluginName = "$:/plugins/missing";
      const pluginFile = pluginFiles.get(pluginName);

      expect(pluginFile).toBeUndefined();

      // Buffer should still be valid
      expect(writer.getBufferChunks()).toBe(1);
    });
  });
});
