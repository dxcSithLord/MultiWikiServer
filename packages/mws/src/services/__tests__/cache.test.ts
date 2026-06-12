/**
 * Test harness for Phase 3 Wiki Template Validation
 *
 * Tests:
 * - Template validation for required markers
 * - Error messages for missing markers
 * - Warning for suspiciously small templates
 * - Validation success for valid templates
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

const REQUIRED_MARKERS = {
  HEAD_CLOSE: '</head>',
  TIDDLER_STORE: '<script class="tiddlywiki-tiddler-store" type="application/json">[',
} as const;

function validateWikiTemplate(templatePath: string, template: string): void {
  const missing: string[] = [];

  for (const [name, marker] of Object.entries(REQUIRED_MARKERS)) {
    if (!template.includes(marker)) {
      missing.push(`'${marker}' (${name})`);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Invalid wiki template at ${templatePath}:\n` +
      `  Missing required markers: ${missing.join(', ')}\n` +
      `  Template may be corrupted or is not a valid TiddlyWiki HTML file.`
    );
  }

  // Warn about suspicious patterns
  if (template.length < 10000) {
    console.warn(
      `Wiki template at ${templatePath} is suspiciously small (${template.length} bytes). ` +
      `Expected ~100KB+. Template may be incomplete.`
    );
  }
}

describe("Cache Service - Phase 3 Template Validation", () => {

  describe("Required Markers Validation", () => {
    it("should pass validation with all required markers present", () => {
      const template = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>TiddlyWiki</title>
        </head>
        <body>
          <script class="tiddlywiki-tiddler-store" type="application/json">[
          {"title": "Test"}
          ]</script>
        </body>
        </html>
      `.repeat(100); // Make it large enough

      expect(() => {
        validateWikiTemplate("/path/to/template.html", template);
      }).not.toThrow();
    });

    it("should throw error when </head> marker is missing", () => {
      const template = `
        <!DOCTYPE html>
        <html>
        <body>
          <script class="tiddlywiki-tiddler-store" type="application/json">[
          {"title": "Test"}
          ]</script>
        </body>
        </html>
      `;

      expect(() => {
        validateWikiTemplate("/path/to/template.html", template);
      }).toThrow("Missing required markers");

      expect(() => {
        validateWikiTemplate("/path/to/template.html", template);
      }).toThrow("'</head>' (HEAD_CLOSE)");
    });

    it("should throw error when tiddler store marker is missing", () => {
      const template = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>TiddlyWiki</title>
        </head>
        <body>
          <script type="application/json">[]</script>
        </body>
        </html>
      `;

      expect(() => {
        validateWikiTemplate("/path/to/template.html", template);
      }).toThrow("Missing required markers");

      expect(() => {
        validateWikiTemplate("/path/to/template.html", template);
      }).toThrow("TIDDLER_STORE");
    });

    it("should throw error when both markers are missing", () => {
      const template = `
        <!DOCTYPE html>
        <html>
        <body>
          <p>Not a valid TiddlyWiki template</p>
        </body>
        </html>
      `;

      try {
        validateWikiTemplate("/path/to/template.html", template);
        expect(true).toBe(false); // Should not reach here
      } catch (err: any) {
        expect(err.message).toContain("Missing required markers");
        expect(err.message).toContain("HEAD_CLOSE");
        expect(err.message).toContain("TIDDLER_STORE");
      }
    });

    it("should include template path in error message", () => {
      const template = "<html><body>Invalid</body></html>";
      const templatePath = "/cache/custom/tiddlywiki5.html";

      try {
        validateWikiTemplate(templatePath, template);
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err.message).toContain(templatePath);
        expect(err.message).toContain("Invalid wiki template at");
      }
    });

    it("should provide helpful error message about corruption", () => {
      const template = "<html></html>";

      try {
        validateWikiTemplate("/path/to/template.html", template);
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err.message).toContain("Template may be corrupted");
        expect(err.message).toContain("not a valid TiddlyWiki HTML file");
      }
    });
  });

  describe("Template Size Validation", () => {
    it("should warn about suspiciously small templates", () => {
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = mock((...args: any[]) => {
        warnings.push(args.join(' '));
      });

      const template = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>TiddlyWiki</title>
        </head>
        <body>
          <script class="tiddlywiki-tiddler-store" type="application/json">[
          ]</script>
        </body>
        </html>
      `; // Less than 10KB

      validateWikiTemplate("/path/to/template.html", template);

      console.warn = originalWarn;

      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]).toContain("suspiciously small");
      expect(warnings[0]).toContain(template.length.toString());
      expect(warnings[0]).toContain("Expected ~100KB+");
    });

    it("should not warn about normal-sized templates", () => {
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = mock((...args: any[]) => {
        warnings.push(args.join(' '));
      });

      // Create a template larger than 10KB
      const baseTemplate = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>TiddlyWiki</title>
          <script>/* padding */</script>
        </head>
        <body>
          <script class="tiddlywiki-tiddler-store" type="application/json">[
          ]</script>
        </body>
        </html>
      `;

      const template = baseTemplate + "x".repeat(15000); // Over 10KB

      validateWikiTemplate("/path/to/template.html", template);

      console.warn = originalWarn;

      expect(warnings.length).toBe(0);
    });

    it("should include actual size and path in warning", () => {
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = mock((...args: any[]) => {
        warnings.push(args.join(' '));
      });

      const template = `
        <!DOCTYPE html>
        <html>
        <head></head>
        <body>
          <script class="tiddlywiki-tiddler-store" type="application/json">[
          ]</script>
        </body>
        </html>
      `;

      const templatePath = "/wiki/cache/tiddlywiki5.html";

      validateWikiTemplate(templatePath, template);

      console.warn = originalWarn;

      expect(warnings[0]).toContain(templatePath);
      expect(warnings[0]).toContain(`${template.length} bytes`);
    });

    it("should still warn even if template has all markers", () => {
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = mock((...args: any[]) => {
        warnings.push(args.join(' '));
      });

      const template = `
        <html>
        <head></head>
        <script class="tiddlywiki-tiddler-store" type="application/json">[</script>
        </html>
      `;

      // Should not throw (has markers) but should warn (too small)
      expect(() => {
        validateWikiTemplate("/path/to/template.html", template);
      }).not.toThrow();

      console.warn = originalWarn;

      expect(warnings.length).toBeGreaterThan(0);
    });
  });

  describe("Marker Detection Edge Cases", () => {
    it("should detect markers case-sensitively", () => {
      const template = `
        <!DOCTYPE html>
        <html>
        <HEAD></HEAD>
        <body>
          <script class="tiddlywiki-tiddler-store" type="application/json">[
          ]</script>
        </body>
        </html>
      `;

      expect(() => {
        validateWikiTemplate("/path/to/template.html", template);
      }).toThrow("Missing required markers");
    });

    it("should detect markers with exact attribute matching", () => {
      const template = `
        <!DOCTYPE html>
        <html>
        <head></head>
        <body>
          <script class="tiddler-store" type="application/json">[
          ]</script>
        </body>
        </html>
      `;

      expect(() => {
        validateWikiTemplate("/path/to/template.html", template);
      }).toThrow("Missing required markers");
    });

    it("should accept markers with whitespace variations", () => {
      const template = (`
        <!DOCTYPE html>
        <html>
        <head>
        </head>
        <body>
          <script class="tiddlywiki-tiddler-store" type="application/json">[
          ]</script>
        </body>
        </html>
      ` + "x".repeat(1000)).repeat(15); // Make it large enough

      expect(() => {
        validateWikiTemplate("/path/to/template.html", template);
      }).not.toThrow();
    });

    it("should detect markers anywhere in template", () => {
      const template = `
        Some content before
        </head>
        More content
        <script class="tiddlywiki-tiddler-store" type="application/json">[
        Content after
      `.repeat(50); // Make it large enough

      expect(() => {
        validateWikiTemplate("/path/to/template.html", template);
      }).not.toThrow();
    });
  });

  describe("Real-World Template Scenarios", () => {
    it("should validate typical TiddlyWiki 5 template structure", () => {
      const template = `
<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="Content-Type" content="text/html;charset=utf-8" />
  <meta name="application-name" content="TiddlyWiki" />
  <meta name="generator" content="TiddlyWiki" />
  <meta name="tiddlywiki-version" content="5.3.0" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="mobile-web-app-capable" content="yes"/>
  <meta name="format-detection" content="telephone=no">
  <link id="faviconLink" rel="shortcut icon" href="favicon.ico">
  <title>My Wiki</title>
  <style>
    /* Styles */
  </style>
</head>
<body class="tc-body">
  <div id="tiddlywiki-root"></div>
  <script class="tiddlywiki-tiddler-store" type="application/json">[
    {"title":"$:/StoryList","text":"","list":""},
    {"title":"$:/HistoryList","text":"","list":""}
  ]</script>
  <script src="tiddlywiki.js"></script>
</body>
</html>
      `.repeat(10); // Make it realistic size

      expect(() => {
        validateWikiTemplate("/cache/tiddlywiki5.html", template);
      }).not.toThrow();
    });

    it("should reject empty template", () => {
      const template = "";

      expect(() => {
        validateWikiTemplate("/path/to/template.html", template);
      }).toThrow("Missing required markers");
    });

    it("should reject template with only HTML structure", () => {
      const template = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Empty</title>
          </head>
          <body>
          </body>
        </html>
      `;

      expect(() => {
        validateWikiTemplate("/path/to/template.html", template);
      }).toThrow("Missing required markers");
    });

    it("should handle templates with minified content", () => {
      const template = `<!DOCTYPE html><html><head></head><body><script class="tiddlywiki-tiddler-store" type="application/json">[{"title":"test"}]</script></body></html>`.repeat(50);

      expect(() => {
        validateWikiTemplate("/path/to/template.html", template);
      }).not.toThrow();
    });

    it("should validate custom wiki templates", () => {
      const template = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Custom Wiki</title>
          <style>body { background: blue; }</style>
        </head>
        <body>
          <h1>Custom Header</h1>
          <div id="custom-container">
            <script class="tiddlywiki-tiddler-store" type="application/json">[
            ]</script>
          </div>
          <footer>Custom Footer</footer>
        </body>
        </html>
      `.repeat(50);

      expect(() => {
        validateWikiTemplate("/custom/wiki.html", template);
      }).not.toThrow();
    });
  });

  describe("Error Recovery Guidance", () => {
    it("should suggest template is corrupted in error", () => {
      const template = "<html><body>Corrupted</body></html>";

      try {
        validateWikiTemplate("/path/to/template.html", template);
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err.message).toContain("corrupted");
      }
    });

    it("should suggest template is not valid TiddlyWiki", () => {
      const template = "<html><body>Not TiddlyWiki</body></html>";

      try {
        validateWikiTemplate("/path/to/template.html", template);
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err.message).toContain("not a valid TiddlyWiki HTML file");
      }
    });

    it("should list all missing markers in single error", () => {
      const template = "<html><body>Invalid</body></html>";

      try {
        validateWikiTemplate("/path/to/template.html", template);
        expect(true).toBe(false);
      } catch (err: any) {
        const message = err.message;
        // Both markers should be listed
        expect(message).toContain("HEAD_CLOSE");
        expect(message).toContain("TIDDLER_STORE");
        // Should be comma-separated
        expect(message).toContain(", ");
      }
    });
  });
});
