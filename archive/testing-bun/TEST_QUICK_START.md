# HTMX Admin Tests - Quick Start

## Run Integration Tests

```bash
# 1. Build and start the server
npm run build
npm start

# 2. In a new terminal, run tests
node test-htmx-admin.mjs http://localhost:8080 admin your_admin_password
```

## Run Unit Tests

```bash
# If you have Bun installed
bun test packages/mws/src/managers/__tests__/

# If you have Vitest
npm install --save-dev vitest
npx vitest packages/mws/src/managers/__tests__/
```

## What Gets Tested

### ✅ Security
- XSS protection (no inline onclick handlers)
- HTML escaping for user data
- CSRF referer validation
- Session expiry handling
- Admin role authorization

### ✅ Functionality
- Profile route redirect
- Template rendering
- Event emissions
- Route registration

## Expected Results

All tests should pass:
```
✓ Passed:  11
✗ Failed:  0
⊘ Skipped: 2
  Total:   13
```

## If Tests Fail

1. **Login failed**: Check admin credentials and server is running
2. **403 errors**: Verify admin user has `isAdmin` flag in database
3. **Template errors**: Run `npm run build` to rebuild
4. **CSRF errors**: Check `admin-utils.ts` referer validation

## Full Documentation

See `HTMX_ADMIN_TESTING.md` for complete testing guide.
