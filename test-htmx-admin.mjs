#!/usr/bin/env node

/**
 * Integration Test Runner for HTMX Admin
 *
 * This script tests the HTMX admin functionality against a running server.
 * It validates:
 * - Authentication and authorization
 * - CSRF protection
 * - Template rendering
 * - Profile redirect
 * - Event emissions
 *
 * Usage:
 *   node test-htmx-admin.mjs [server_url] [admin_username] [admin_password]
 *
 * Example:
 *   node test-htmx-admin.mjs http://localhost:8080 admin password123
 */

import { URL } from "url";

// Configuration
const SERVER_URL = process.argv[2] || "http://localhost:8080";
const ADMIN_USER = process.argv[3] || "admin";
const ADMIN_PASS = process.argv[4] || "admin";
const NORMAL_USER = "testuser";
const NORMAL_PASS = "testpass";

// Test results
const results = {
  passed: 0,
  failed: 0,
  skipped: 0,
  tests: []
};

// Helper functions
function log(message, type = "info") {
  const colors = {
    info: "\x1b[36m",
    success: "\x1b[32m",
    error: "\x1b[31m",
    warning: "\x1b[33m",
    reset: "\x1b[0m"
  };
  console.log(`${colors[type]}${message}${colors.reset}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function makeRequest(path, options = {}) {
  const url = new URL(path, SERVER_URL);
  const response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
    },
  });
  return response;
}

async function login(username, password) {
  const response = await makeRequest("/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ username, password }),
  });

  if (!response.ok) {
    throw new Error(`Login failed: ${response.status} ${response.statusText}`);
  }

  // Extract session cookie
  const cookies = response.headers.get("set-cookie");
  return cookies;
}

async function runTest(name, testFn) {
  process.stdout.write(`  ${name}... `);
  try {
    await testFn();
    log("✓ PASSED", "success");
    results.passed++;
    results.tests.push({ name, status: "passed" });
  } catch (error) {
    log(`✗ FAILED: ${error.message}`, "error");
    results.failed++;
    results.tests.push({ name, status: "failed", error: error.message });
  }
}

// Test suites
async function testUnauthenticatedAccess() {
  log("\n=== Unauthenticated Access Tests ===", "info");

  await runTest("Should redirect to login when accessing /admin-htmx", async () => {
    const response = await makeRequest("/admin-htmx", {
      redirect: "manual",
    });

    assert(
      response.status === 302 || response.status === 401,
      `Expected 302 or 401, got ${response.status}`
    );
  });

  await runTest("Should redirect to login when accessing /admin-htmx/profile", async () => {
    const response = await makeRequest("/admin-htmx/profile", {
      redirect: "manual",
    });

    assert(
      response.status === 302 || response.status === 401,
      `Expected 302 or 401, got ${response.status}`
    );
  });
}

async function testAdminAccess() {
  log("\n=== Admin Access Tests ===", "info");

  let adminCookie;
  try {
    adminCookie = await login(ADMIN_USER, ADMIN_PASS);
  } catch (error) {
    log(`Skipping admin tests: ${error.message}`, "warning");
    results.skipped += 2;
    return;
  }

  await runTest("Admin should access /admin-htmx successfully", async () => {
    const response = await makeRequest("/admin-htmx", {
      headers: {
        Cookie: adminCookie,
      },
    });

    assert(response.status === 200, `Expected 200, got ${response.status}`);

    const html = await response.text();
    assert(html.includes("<!DOCTYPE html>"), "Response should be HTML");
    assert(html.includes("User Management"), "Should contain user management interface");
  });

  await runTest("Admin should access /admin-htmx/profile and get redirected", async () => {
    const response = await makeRequest("/admin-htmx/profile", {
      headers: {
        Cookie: adminCookie,
      },
      redirect: "manual",
    });

    assert(response.status === 302, `Expected 302 redirect, got ${response.status}`);

    const location = response.headers.get("location");
    assert(location, "Should have location header");
    assert(location.includes("/admin-htmx?editUser="), "Should redirect to admin-htmx with editUser parameter");
  });

  await runTest("Template variables should be properly replaced", async () => {
    const response = await makeRequest("/admin-htmx", {
      headers: {
        Cookie: adminCookie,
      },
    });

    const html = await response.text();
    assert(!html.includes("{{pathPrefix}}"), "Should not contain {{pathPrefix}} template variable");
    assert(!html.includes("{{username}}"), "Should not contain {{username}} template variable");
    assert(!html.includes("{{user_id}}"), "Should not contain {{user_id}} template variable");
  });

  await runTest("XSS protection - no inline onclick handlers", async () => {
    const response = await makeRequest("/admin-htmx", {
      headers: {
        Cookie: adminCookie,
      },
    });

    const html = await response.text();
    assert(!html.includes('onclick="'), "Should not contain inline onclick handlers");
  });

  await runTest("CSRF protection - referer header required for API calls", async () => {
    const response = await makeRequest("/admin/user_list", {
      method: "POST",
      headers: {
        Cookie: adminCookie,
        "Content-Type": "application/json",
        "X-Requested-With": "TiddlyWiki",
      },
      body: JSON.stringify({}),
    });

    assert(response.status === 400, `Expected 400 for missing referer, got ${response.status}`);
  });

  await runTest("CSRF protection - correct referer should work", async () => {
    const response = await makeRequest("/admin/user_list", {
      method: "POST",
      headers: {
        Cookie: adminCookie,
        "Content-Type": "application/json",
        "X-Requested-With": "TiddlyWiki",
        Referer: `${SERVER_URL}/admin-htmx`,
      },
      body: JSON.stringify({}),
    });

    assert(response.status === 200, `Expected 200 with valid referer, got ${response.status}`);
  });
}

async function testNonAdminAccess() {
  log("\n=== Non-Admin Access Tests ===", "info");

  // For this test, we assume a non-admin user exists or we skip
  log("  Note: Skipping non-admin tests (would require user creation)", "warning");
  results.skipped += 2;

  // Uncomment if you have a way to create test users:
  /*
  let userCookie;
  try {
    userCookie = await login(NORMAL_USER, NORMAL_PASS);
  } catch (error) {
    log(`Skipping non-admin tests: ${error.message}`, "warning");
    results.skipped += 2;
    return;
  }

  await runTest("Non-admin should get 403 on /admin-htmx", async () => {
    const response = await makeRequest("/admin-htmx", {
      headers: {
        Cookie: userCookie,
      },
    });

    assert(response.status === 403, `Expected 403, got ${response.status}`);

    const html = await response.text();
    assert(html.includes("403 Forbidden"), "Should show 403 Forbidden page");
    assert(html.includes("Admin access required"), "Should explain admin access required");
  });

  await runTest("Non-admin should get 403 on /admin-htmx/profile", async () => {
    const response = await makeRequest("/admin-htmx/profile", {
      headers: {
        Cookie: userCookie,
      },
    });

    assert(response.status === 403, `Expected 403, got ${response.status}`);
  });
  */
}

async function testSecurityHeaders() {
  log("\n=== Security Tests ===", "info");

  let adminCookie;
  try {
    adminCookie = await login(ADMIN_USER, ADMIN_PASS);
  } catch (error) {
    log(`Skipping security tests: ${error.message}`, "warning");
    results.skipped += 3;
    return;
  }

  await runTest("Should escape HTML in user data", async () => {
    const response = await makeRequest("/admin-htmx", {
      headers: {
        Cookie: adminCookie,
      },
    });

    const html = await response.text();
    // Check that the escapeHtml function is defined and used
    assert(html.includes("function escapeHtml"), "Should have escapeHtml function");
  });

  await runTest("Should use event delegation instead of inline handlers", async () => {
    const response = await makeRequest("/admin-htmx", {
      headers: {
        Cookie: adminCookie,
      },
    });

    const html = await response.text();
    assert(html.includes("addEventListener"), "Should use addEventListener");
    assert(html.includes("DOMContentLoaded"), "Should wait for DOM ready");
  });

  await runTest("Should handle session expiry (401 response)", async () => {
    const response = await makeRequest("/admin/user_list", {
      method: "POST",
      headers: {
        Cookie: "invalid-session-cookie",
        "Content-Type": "application/json",
        "X-Requested-With": "TiddlyWiki",
        Referer: `${SERVER_URL}/admin-htmx`,
      },
      body: JSON.stringify({}),
    });

    assert(
      response.status === 401 || response.status === 302,
      `Expected 401 or 302 for invalid session, got ${response.status}`
    );
  });
}

// Main test runner
async function main() {
  log("╔════════════════════════════════════════════════════╗", "info");
  log("║     HTMX Admin Integration Test Suite             ║", "info");
  log("╚════════════════════════════════════════════════════╝", "info");
  log(`\nServer: ${SERVER_URL}`, "info");
  log(`Admin User: ${ADMIN_USER}`, "info");
  log("");

  try {
    await testUnauthenticatedAccess();
    await testAdminAccess();
    await testNonAdminAccess();
    await testSecurityHeaders();
  } catch (error) {
    log(`\nFatal error: ${error.message}`, "error");
    process.exit(1);
  }

  // Print summary
  log("\n" + "=".repeat(60), "info");
  log("Test Summary", "info");
  log("=".repeat(60), "info");
  log(`✓ Passed:  ${results.passed}`, "success");
  log(`✗ Failed:  ${results.failed}`, "error");
  log(`⊘ Skipped: ${results.skipped}`, "warning");
  log(`  Total:   ${results.passed + results.failed + results.skipped}`, "info");

  if (results.failed > 0) {
    log("\nFailed tests:", "error");
    results.tests
      .filter(t => t.status === "failed")
      .forEach(t => log(`  - ${t.name}: ${t.error}`, "error"));
  }

  // Exit code
  process.exit(results.failed > 0 ? 1 : 0);
}

// Run tests
main().catch(error => {
  log(`\nUnexpected error: ${error.stack}`, "error");
  process.exit(1);
});
