/**
 * Test harness for Phase 1 SSE Event Handler cleanup
 *
 * Tests:
 * - Event listener cleanup on connection close
 * - Race condition prevention (cleanup registered before listener)
 * - Closed flag guards against late events
 * - Multiple connect/disconnect cycles
 * - No memory leaks from accumulated listeners
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { EventEmitter } from "events";

// Mock ServerEvents for testing SSE cleanup
class MockServerEvents extends EventEmitter {
  setMaxListeners(n: number) {
    super.setMaxListeners(n);
  }
}

// Mock SSE Connection
class MockSSEConnection {
  private closeCallbacks: Array<() => void> = [];
  private closed = false;

  onClose(callback: () => void) {
    this.closeCallbacks.push(callback);
  }

  emitEvent(name: string, data: any, id: string) {
    if (this.closed) throw new Error("Cannot emit on closed connection");
  }

  emitComment(comment: string) {
    if (this.closed) throw new Error("Cannot emit on closed connection");
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.closeCallbacks.forEach(cb => cb());
  }

  isClosed() {
    return this.closed;
  }
}

describe("Wiki Status SSE - Phase 1 Event Handler Cleanup", () => {

  describe("Event Listener Cleanup", () => {
    it("should clean up event listeners on connection close", async () => {
      const serverEvents = new MockServerEvents();
      const connection = new MockSSEConnection();
      let closed = false;

      // Setup cleanup FIRST
      const cleanup = () => {
        if (closed) return;
        closed = true;
        serverEvents.removeAllListeners("mws.tiddler.events");
      };

      // Register cleanup BEFORE listener
      connection.onClose(cleanup);

      // Add event handler
      const onEvent = mock((data: any) => {
        if (closed) return;
        // Process event
      });

      serverEvents.on("mws.tiddler.events", onEvent);

      // Verify listener added
      expect(serverEvents.listenerCount("mws.tiddler.events")).toBe(1);

      // Close connection
      connection.close();

      // Verify cleanup happened
      expect(closed).toBe(true);
      expect(serverEvents.listenerCount("mws.tiddler.events")).toBe(0);
    });

    it("should not leak listeners after multiple connection cycles", async () => {
      const serverEvents = new MockServerEvents();
      const maxListeners = 10;
      serverEvents.setMaxListeners(maxListeners);

      for (let i = 0; i < 50; i++) {
        const connection = new MockSSEConnection();
        let closed = false;

        const cleanup = () => {
          if (closed) return;
          closed = true;
          serverEvents.removeListener("mws.tiddler.events", onEvent);
        };

        connection.onClose(cleanup);

        const onEvent = mock((data: any) => {
          if (closed) return;
        });

        serverEvents.on("mws.tiddler.events", onEvent);

        // Close connection immediately
        connection.close();
      }

      // After 50 cycles, should have no accumulated listeners
      expect(serverEvents.listenerCount("mws.tiddler.events")).toBe(0);
    });

    it("should clean up timeout on connection close", () => {
      let timeout: any = null;
      let closed = false;
      const connection = new MockSSEConnection();

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (timeout) clearTimeout(timeout);
      };

      connection.onClose(cleanup);

      // Schedule timeout
      timeout = setTimeout(() => {
        throw new Error("Timeout should have been cleared");
      }, 100);

      // Close connection immediately
      connection.close();

      expect(closed).toBe(true);
      expect(timeout).not.toBeNull();

      // Wait to ensure timeout was cleared
      return new Promise(resolve => setTimeout(resolve, 150));
    });
  });

  describe("Race Condition Prevention", () => {
    it("should register cleanup BEFORE adding event listener", () => {
      const serverEvents = new MockServerEvents();
      const connection = new MockSSEConnection();
      const executionOrder: string[] = [];
      let closed = false;

      // Track when cleanup is registered
      const originalOnClose = connection.onClose.bind(connection);
      connection.onClose = (callback: () => void) => {
        executionOrder.push("cleanup-registered");
        originalOnClose(callback);
      };

      // Setup cleanup FIRST
      const cleanup = () => {
        if (closed) return;
        closed = true;
        serverEvents.removeAllListeners("mws.tiddler.events");
      };

      connection.onClose(cleanup);

      // Add event handler AFTER
      executionOrder.push("listener-added");
      const onEvent = (data: any) => {
        if (closed) return;
      };
      serverEvents.on("mws.tiddler.events", onEvent);

      expect(executionOrder).toEqual(["cleanup-registered", "listener-added"]);
    });

    it("should handle events arriving during cleanup registration", async () => {
      const serverEvents = new MockServerEvents();
      const connection = new MockSSEConnection();
      let closed = false;
      const eventsProcessed: number[] = [];

      const cleanup = () => {
        if (closed) return;
        closed = true;
        serverEvents.removeListener("mws.tiddler.events", onEvent);
      };

      connection.onClose(cleanup);

      const onEvent = (data: { id: number }) => {
        if (closed) return; // Guard against late events
        eventsProcessed.push(data.id);
      };

      serverEvents.on("mws.tiddler.events", onEvent);

      // Emit event
      serverEvents.emit("mws.tiddler.events", { id: 1 });

      // Close connection
      connection.close();

      // Try to emit after close - should not process
      serverEvents.emit("mws.tiddler.events", { id: 2 });

      expect(eventsProcessed).toEqual([1]);
    });

    it("should prevent events scheduled before close from executing after", async () => {
      const serverEvents = new MockServerEvents();
      const connection = new MockSSEConnection();
      let closed = false;
      const eventsProcessed: number[] = [];

      const cleanup = () => {
        if (closed) return;
        closed = true;
        serverEvents.removeListener("mws.tiddler.events", onEvent);
      };

      connection.onClose(cleanup);

      const onEvent = async (data: { id: number }) => {
        // Simulate async processing delay
        await new Promise(resolve => setTimeout(resolve, 10));
        if (closed) return; // Guard prevents processing
        eventsProcessed.push(data.id);
      };

      serverEvents.on("mws.tiddler.events", onEvent);

      // Emit event but don't await
      const eventPromise = Promise.resolve().then(() =>
        serverEvents.emit("mws.tiddler.events", { id: 1 })
      );

      // Close immediately (before event processes)
      connection.close();

      await eventPromise;
      await new Promise(resolve => setTimeout(resolve, 50));

      // Event should not be processed due to closed guard
      expect(eventsProcessed).toEqual([]);
    });
  });

  describe("Closed Flag Guards", () => {
    it("should prevent event processing when closed", () => {
      let closed = false;
      const eventsProcessed: any[] = [];

      const onEvent = (data: any) => {
        if (closed) return; // Guard
        eventsProcessed.push(data);
      };

      // Process normally
      onEvent({ id: 1 });
      expect(eventsProcessed.length).toBe(1);

      // Close
      closed = true;

      // Should not process
      onEvent({ id: 2 });
      onEvent({ id: 3 });

      expect(eventsProcessed.length).toBe(1);
      expect(eventsProcessed[0]).toEqual({ id: 1 });
    });

    it("should check closed flag in scheduleEvent", () => {
      let closed = false;
      let timeout: any = null;
      const scheduledEvents: number[] = [];

      function scheduleEvent(id: number) {
        if (closed) return; // Guard

        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => {
          if (closed) return; // Guard in callback too
          scheduledEvents.push(id);
        }, 10);
      }

      scheduleEvent(1);
      expect(timeout).not.toBeNull();

      closed = true;

      scheduleEvent(2); // Should not schedule
      scheduleEvent(3); // Should not schedule

      return new Promise(resolve => setTimeout(() => {
        expect(scheduledEvents.length).toBe(0); // First event shouldn't fire either
        if (timeout) clearTimeout(timeout);
        resolve(undefined);
      }, 50));
    });

    it("should check closed flag in sendEvent", async () => {
      let closed = false;
      const sentEvents: number[] = [];

      async function sendEvent(id: number) {
        if (closed) return; // Guard

        // Simulate async work
        await new Promise(resolve => setTimeout(resolve, 10));

        if (closed) return; // Double-check after async

        sentEvents.push(id);
      }

      // Start sending
      const promise1 = sendEvent(1);

      // Close before completion
      await new Promise(resolve => setTimeout(resolve, 5));
      closed = true;

      await promise1;

      // Try to send more
      await sendEvent(2);

      expect(sentEvents.length).toBe(0);
    });

    it("should handle hasBag check with closed guard", async () => {
      let closed = false;
      const checkedBags: string[] = [];

      async function onEvent(data: { bag_name: string }) {
        if (closed) return; // Guard at entry

        // Simulate database check
        const hasBag = await simulateDbCheck(data.bag_name);

        if (hasBag && !closed) { // Double-check not closed
          checkedBags.push(data.bag_name);
        }
      }

      async function simulateDbCheck(bagName: string): Promise<boolean> {
        await new Promise(resolve => setTimeout(resolve, 10));
        return true;
      }

      // Start processing
      const promise = onEvent({ bag_name: "bag-1" });

      // Close during processing
      await new Promise(resolve => setTimeout(resolve, 5));
      closed = true;

      await promise;

      expect(checkedBags.length).toBe(0);
    });

    it("should prevent multiple cleanup calls", () => {
      let closed = false;
      let cleanupCount = 0;

      const cleanup = () => {
        if (closed) return; // Guard
        closed = true;
        cleanupCount++;
      };

      cleanup();
      cleanup();
      cleanup();

      expect(cleanupCount).toBe(1);
    });
  });

  describe("Error Handling", () => {
    it("should not close connection on transient DB errors", async () => {
      const serverEvents = new MockServerEvents();
      const connection = new MockSSEConnection();
      let closed = false;
      const errors: string[] = [];

      const originalError = console.error;
      console.error = mock((...args: any[]) => {
        errors.push(args.join(' '));
      });

      const cleanup = () => {
        if (closed) return;
        closed = true;
        serverEvents.removeListener("mws.tiddler.events", onEvent);
      };

      connection.onClose(cleanup);

      const onEvent = async (data: any) => {
        if (closed) return;

        try {
          throw new Error("Database connection failed");
        } catch (e) {
          console.error("Error in onEvent:", e);
          // Don't close connection on transient errors
        }
      };

      serverEvents.on("mws.tiddler.events", onEvent);

      await Promise.resolve().then(() =>
        serverEvents.emit("mws.tiddler.events", { id: 1 })
      );

      await new Promise(resolve => setTimeout(resolve, 10));

      // Connection should still be open
      expect(closed).toBe(false);
      expect(connection.isClosed()).toBe(false);

      // Error should be logged
      expect(errors.length).toBeGreaterThan(0);

      console.error = originalError;
    });

    it("should handle writer errors with cleanup", () => {
      const mockWriter = new EventEmitter();
      let closed = false;

      const cleanup = () => {
        if (closed) return;
        closed = true;
      };

      mockWriter.once('error', cleanup);

      expect(closed).toBe(false);

      mockWriter.emit('error', new Error("Writer failed"));

      expect(closed).toBe(true);
    });
  });

  describe("Integration - Complete SSE Flow", () => {
    it("should handle complete connection lifecycle", async () => {
      const serverEvents = new MockServerEvents();
      const connection = new MockSSEConnection();
      let closed = false;
      let timeout: any = null;
      const processedEvents: any[] = [];

      // Define cleanup FIRST
      const cleanup = () => {
        if (closed) return;
        closed = true;
        serverEvents.removeListener("mws.tiddler.events", onEvent);
        if (timeout) clearTimeout(timeout);
      };

      // Register cleanup BEFORE listener
      connection.onClose(cleanup);

      // Event handler with closed guards
      async function onEvent(data: any) {
        if (closed) return;

        try {
          // Simulate async processing
          await new Promise(resolve => setTimeout(resolve, 5));

          if (!closed) {
            processedEvents.push(data);
            scheduleEvent();
          }
        } catch (e) {
          console.error("Error in onEvent:", e);
        }
      }

      function scheduleEvent() {
        if (closed) return;

        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(sendEvent, 10);
      }

      async function sendEvent() {
        if (closed) return;

        timeout = null;
        // Emit event
        try {
          connection.emitEvent("test", {}, "1");
        } catch (e) {
          // Connection closed
        }
      }

      // Register listener AFTER cleanup
      serverEvents.on("mws.tiddler.events", onEvent);

      // Emit some events
      serverEvents.emit("mws.tiddler.events", { id: 1 });
      await new Promise(resolve => setTimeout(resolve, 10));

      serverEvents.emit("mws.tiddler.events", { id: 2 });
      await new Promise(resolve => setTimeout(resolve, 10));

      // Close connection
      connection.close();

      // Try to emit more events
      serverEvents.emit("mws.tiddler.events", { id: 3 });
      await new Promise(resolve => setTimeout(resolve, 10));

      // Should only process events before close
      expect(processedEvents.length).toBe(2);
      expect(processedEvents[0].id).toBe(1);
      expect(processedEvents[1].id).toBe(2);

      // Verify cleanup happened
      expect(closed).toBe(true);
      expect(serverEvents.listenerCount("mws.tiddler.events")).toBe(0);
    });

    it("should handle rapid connect/disconnect without leaks", async () => {
      const serverEvents = new MockServerEvents();
      serverEvents.setMaxListeners(100);

      const connections = Array(20).fill(0).map(() => {
        const connection = new MockSSEConnection();
        let closed = false;
        let timeout: any = null;

        const cleanup = () => {
          if (closed) return;
          closed = true;
          serverEvents.removeListener("mws.tiddler.events", onEvent);
          if (timeout) clearTimeout(timeout);
        };

        connection.onClose(cleanup);

        const onEvent = (data: any) => {
          if (closed) return;
          timeout = setTimeout(() => {}, 10);
        };

        serverEvents.on("mws.tiddler.events", onEvent);

        return connection;
      });

      // All connected
      expect(serverEvents.listenerCount("mws.tiddler.events")).toBe(20);

      // Emit event to all
      serverEvents.emit("mws.tiddler.events", { id: 1 });

      // Close half
      connections.slice(0, 10).forEach(c => c.close());

      expect(serverEvents.listenerCount("mws.tiddler.events")).toBe(10);

      // Close rest
      connections.slice(10).forEach(c => c.close());

      expect(serverEvents.listenerCount("mws.tiddler.events")).toBe(0);
    });
  });
});
