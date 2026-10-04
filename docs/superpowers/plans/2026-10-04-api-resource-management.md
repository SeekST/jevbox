# API Resource Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let API keys and OAuth clients list, create, rename, move, and delete library resources through `/api/v1` and MCP, under a new `documents:manage` scope and the same permission rules as the web app.

**Architecture:** Extract the browser's resource rules from `server/app.ts` into `server/resources.ts` (`createResourceOperations`). Browser routes, new `/api/v1` routes, and new MCP tools all call it. `server/external-access.ts` adds scope checks, credential revalidation before commit, and the API response shape; `server/mcp.ts` registers tools from those methods.

**Tech Stack:** TypeScript, Express 5, zod 4, PostgreSQL, SpiceDB, Better Auth (API key + MCP/OAuth plugins), `@modelcontextprotocol/server`, `node:test` via `tsx`.

**Spec:** `docs/superpowers/specs/2026-10-04-api-resource-management-design.md`

## Global Constraints

- All work happens on branch `feat/api-resource-management`; `origin` is the fork `https://github.com/SeekST/jevbox.git`, `upstream` is `extend-hq/jevbox`. Push only to `origin`.
- New scope string is exactly `documents:manage`, label exactly "Organize, rename, move, and delete documents".
- API key default permissions become `documents: ["read", "write", "manage"]`, `search: ["read"]`. No migration of existing keys.
- Audit actions: browser keeps `folder.create`, `resource.update`, `resource.move`, `resource.delete`; API and MCP use `api.folder.create`, `api.resource.update`, `api.resource.move`, `api.resource.delete`.
- Missing or inaccessible resources return 404, missing scope 403, invalid input 400. Never reveal resources from other organizations or without read access.
- Folders created through the API start `restricted` and are owned by the caller.
- `delete_resource` MCP tool has `destructiveHint: true`.
- Browser routes under `/api/*` must keep rejecting API keys.
- Commit message style matches the repo (plain imperative sentence, no prefix) and ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Test Environment

Tests need local services: `pnpm services:up` (PostgreSQL on 55432, SpiceDB on 58443) and `.env` with `DATABASE_URL`. Run one file with:

```bash
npx tsx --env-file-if-exists=.env --test tests/api-access.test.ts
```

Baseline on `7e45621`: `tests/api-access.test.ts` 19/19 pass (~9 s). Full `pnpm test`: 401 tests, 390 pass, 6 fail, 5 cancelled. Pre-existing failures, unrelated to this work: `streaming consumes text while partial persistence is pending...`, `original PDF rendering selects the requested page...`, four `generates a bounded content thumbnail for pdf/docx/pptx/xlsx`, and cancelled `upload admission bounds waiting requests...`, `upload memory backpressure...`, `text and parsed documents index beyond...`, `parser responses above the former 16 MiB cap...`, `storage and document limits apply independently...`. "No regressions" means no test outside this list fails.

## Review Focus

1. **Deleting a document that is still queued for indexing** — a document just uploaded through the API must be deletable immediately (200), not stuck. Test in Task 4.
2. **Repeating a delete or acting on an already-deleted ID** — the second call returns 404, never 500. Tests in Task 4 (REST) and Task 5 (MCP `isError`).
3. **`parentId` that is a document, not a folder** — list returns 404, create folder and move return 400. Tests in Tasks 3 and 4.
4. **Names with slashes, control characters, or over 160 characters** — 400, nothing written. Test in Task 4.
5. **IDs from another organization** (`foreignId`, `foreignOrgId`) — 404 on every route. Tests in Tasks 3 and 4.

---

## File Map

| File | Change | Responsibility |
| --- | --- | --- |
| `server/resources.ts` | Create | Resource rules: list, createFolder, rename, move, remove; audit; transaction with pre-commit revalidation |
| `server/app.ts` | Modify | Browser routes delegate to `server/resources.ts`; drop inline `name` validator and `deleteResources` |
| `shared/api-access.ts` | Modify | Add `documents:manage` scope and label |
| `server/auth.ts` | Modify | API key default permissions include `manage` |
| `server/api-keys.ts` | Modify | Map `manage` permission to scope |
| `server/external-access.ts` | Modify | Input schemas, `listResources`, `createFolder`, `renameResource`, `moveResource`, `deleteResource`, REST routes, delegated scope mapping |
| `server/mcp.ts` | Modify | Register `list_resources` and four management tools |
| `tests/api-access.test.ts` | Modify | New tests, updated MCP tool-name lists |
| `docs/api-access.md`, `docs/security.md` | Modify | Public documentation |
| `src/components/api-usage-guide.tsx`, `src/components/mcp-usage-guide.tsx` | Modify | In-app guides |

Deviation from spec, intentional: `createExternalAccess` builds its own `createResourceOperations(store)` internally (the module is stateless, like `createApiKeys(auth)`), so its three callers (`server/app.ts`, `server/workers.ts`, `tests/api-access.test.ts:1535`) need no signature change. The browser `GET /api/resources` stays on `publicResources`, which already filters reads in the same permission batch.

---

### Task 1: Extract resource operations into `server/resources.ts`

**Files:**
- Create: `server/resources.ts`
- Modify: `server/app.ts` (imports at lines 34-50; `name` validator at 54-62; `/api/folders` at 757-791; `PATCH /api/resources/:id` at 959-984; move at 985-1037; `deleteResources` and delete routes at 1038-1086)
- Test: `tests/api-access.test.ts` (append)

**Interfaces:**
- Produces:
  - `export const resourceName: z.ZodType<string>` (trimmed, 1-160 chars, no slashes or control characters)
  - `export const resourceDescription` (`z.string().max(1000).default("")`)
  - `export type ResourceChange = { auditPrefix?: "" | "api."; revalidate?: () => Promise<unknown> }`
  - `export function createResourceOperations(store: Store)` returning:
    - `list(a: Actor, filter?: { parentId?: string; kind?: "document" | "folder" }): Promise<Resource[]>`
    - `createFolder(a: Actor, input: { name: string; description: string; parentId: string | null }, options?: ResourceChange): Promise<{ id: string }>`
    - `rename(a: Actor, id: string, input: { name: string; description: string }, options?: ResourceChange): Promise<void>`
    - `move(a: Actor, id: string, parentId: string | null, options?: ResourceChange): Promise<void>`
    - `remove(a: Actor, ids: string[], options?: ResourceChange): Promise<number>`

- [ ] **Step 1: Write the failing test**

Append to `tests/api-access.test.ts`:

```ts
test("resource changes roll back when revalidation fails and deletes require share on every descendant", async () => {
  const { createResourceOperations } = await import("../server/resources");
  const resources = createResourceOperations(runtime.store);
  const a = { userId, orgId, role: "member", token: "test" };
  const revoked = {
    revalidate: async () => {
      throw new Error("Revoked");
    },
  };
  const folderId = randomUUID();
  const foreignChild = randomUUID();
  await runtime.store.run(
    "INSERT INTO resources(id,org_id,owner_id,kind,name,created) VALUES(?,?,?,'folder',?,?)",
    folderId,
    orgId,
    userId,
    "Rollback folder",
    new Date().toISOString(),
  );
  const named = async (name: string) =>
    (
      await runtime.store.one<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM resources WHERE name=?",
        name,
      )
    )?.count;
  await assert.rejects(
    resources.createFolder(
      a,
      { name: "Revoked folder", description: "", parentId: null },
      revoked,
    ),
    /Revoked/,
  );
  assert.equal(await named("Revoked folder"), "0");
  await assert.rejects(
    resources.rename(a, folderId, { name: "Renamed", description: "" }, revoked),
    /Revoked/,
  );
  assert.equal(await named("Rollback folder"), "1");
  await assert.rejects(resources.remove(a, [folderId], revoked), /Revoked/);
  assert.equal(await named("Rollback folder"), "1");
  await runtime.store.run(
    "INSERT INTO resources(id,org_id,owner_id,parent_id,kind,name,access,created) VALUES(?,?,?,?,'document',?,'inherit',?)",
    foreignChild,
    orgId,
    otherId,
    folderId,
    "Other member's document",
    new Date().toISOString(),
  );
  await assert.rejects(
    resources.remove(a, [folderId]),
    /Resource not found/,
  );
  assert.equal(await named("Rollback folder"), "1");
  assert.equal(await named("Other member's document"), "1");
  await runtime.store.run("DELETE FROM resources WHERE id=?", foreignChild);
  assert.equal(
    await resources.remove(a, [folderId], { auditPrefix: "api." }),
    1,
  );
  assert.equal(await named("Rollback folder"), "0");
  assert.ok(
    await runtime.store.one(
      "SELECT 1 FROM audit WHERE resource_id=? AND action='api.resource.delete'",
      folderId,
    ),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --env-file-if-exists=.env --test --test-name-pattern="resource changes roll back" tests/api-access.test.ts`
Expected: FAIL with `Cannot find module '../server/resources'` (or `ERR_MODULE_NOT_FOUND`).

- [ ] **Step 3: Create `server/resources.ts`**

```ts
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  HttpError,
  requireResource,
  visibleResources,
  type Actor,
  type Resource,
  type Store,
} from "./db";

export const resourceName = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine(
    (s) => !/[\x00-\x1f/\\]/.test(s),
    "Use a name without slashes or control characters",
  );
export const resourceDescription = z.string().max(1000).default("");

export type ResourceChange = {
  auditPrefix?: "" | "api.";
  // Runs inside the transaction after the change; throwing rolls it back.
  revalidate?: () => Promise<unknown>;
};

export function createResourceOperations(store: Store) {
  const now = () => new Date().toISOString();
  const audit = (a: Actor, action: string, resourceId: string) =>
    store.run(
      "INSERT INTO audit(org_id,user_id,action,resource_id,created) VALUES(?,?,?,?,?)",
      a.orgId,
      a.userId,
      action,
      resourceId,
      now(),
    );
  function change<T>(
    options: ResourceChange,
    work: (prefix: string) => Promise<T>,
  ) {
    return store.transaction(async () => {
      const result = await work(options.auditPrefix ?? "");
      await options.revalidate?.();
      return result;
    });
  }
  async function list(
    a: Actor,
    filter: { parentId?: string; kind?: Resource["kind"] } = {},
  ) {
    if (
      filter.parentId &&
      (await requireResource(store, a, filter.parentId)).kind !== "folder"
    )
      throw new HttpError(404, "Folder not found");
    return (await visibleResources(store, a)).filter(
      (r) =>
        (!filter.parentId || r.parent_id === filter.parentId) &&
        (!filter.kind || r.kind === filter.kind),
    );
  }
  function createFolder(
    a: Actor,
    input: { name: string; description: string; parentId: string | null },
    options: ResourceChange = {},
  ) {
    return change(options, async (prefix) => {
      if (
        input.parentId &&
        (await requireResource(store, a, input.parentId, "write")).kind !==
          "folder"
      )
        throw new HttpError(400, "Invalid parent");
      const id = randomUUID();
      await store.run(
        "INSERT INTO resources(id,org_id,owner_id,parent_id,kind,name,description,created) VALUES(?,?,?,?,'folder',?,?,?)",
        id,
        a.orgId,
        a.userId,
        input.parentId,
        input.name,
        input.description,
        now(),
      );
      await audit(a, `${prefix}folder.create`, id);
      return { id };
    });
  }
  function rename(
    a: Actor,
    id: string,
    input: { name: string; description: string },
    options: ResourceChange = {},
  ) {
    return change(options, async (prefix) => {
      const r = await requireResource(store, a, id, "write");
      await store.run(
        "UPDATE resources SET name=?,description=? WHERE id=?",
        input.name,
        input.description,
        r.id,
      );
      await audit(a, `${prefix}resource.update`, r.id);
    });
  }
  function move(
    a: Actor,
    id: string,
    parentId: string | null,
    options: ResourceChange = {},
  ) {
    return change(options, async (prefix) => {
      const resource = await requireResource(store, a, id, "share");
      await store.run(
        "UPDATE document_filing SET state='completed',outcome=?,attempt_id=NULL,error=NULL WHERE resource_id=?",
        JSON.stringify({ reason: "manual", parentId }),
        resource.id,
      );
      if (parentId === resource.parent_id) return;
      if (parentId) {
        const destination = await requireResource(store, a, parentId, "write");
        if (destination.kind !== "folder")
          throw new HttpError(400, "Choose a folder as the destination");
        let ancestor: string | null = parentId;
        const seen = new Set<string>();
        while (ancestor) {
          if (ancestor === resource.id || seen.has(ancestor))
            throw new HttpError(
              400,
              "A folder cannot be moved into itself or its descendants",
            );
          seen.add(ancestor);
          const parent: { parent_id: string | null } | undefined =
            await store.one(
              "SELECT parent_id FROM resources WHERE id=? AND org_id=?",
              ancestor,
              a.orgId,
            );
          ancestor = parent?.parent_id ?? null;
        }
      }
      await store.run(
        "UPDATE resources SET parent_id=?,access=CASE WHEN ?::text IS NULL AND access='inherit' THEN 'restricted' ELSE access END WHERE id=?",
        parentId,
        parentId,
        resource.id,
      );
      await audit(a, `${prefix}resource.move`, resource.id);
    });
  }
  function remove(a: Actor, selectedIds: string[], options: ResourceChange = {}) {
    return change(options, async (prefix) => {
      for (const resourceId of selectedIds)
        await requireResource(store, a, resourceId, "share");
      const descendants = await store.all<{ id: string }>(
        `WITH RECURSIVE subtree AS (
          SELECT id FROM resources WHERE org_id=? AND id=ANY(?::text[])
          UNION
          SELECT r.id FROM resources r JOIN subtree s ON r.parent_id=s.id WHERE r.org_id=?
        ) SELECT id FROM subtree`,
        a.orgId,
        selectedIds,
        a.orgId,
      );
      const resourceIds = descendants.map((resource) => resource.id);
      for (const resourceId of resourceIds)
        if (!selectedIds.includes(resourceId))
          await requireResource(store, a, resourceId, "share");
      await store.run(
        "DELETE FROM resources WHERE org_id=? AND id=ANY(?::text[])",
        a.orgId,
        resourceIds,
      );
      for (const resourceId of resourceIds)
        await audit(a, `${prefix}resource.delete`, resourceId);
      return resourceIds.length;
    });
  }
  return { list, createFolder, rename, move, remove };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --env-file-if-exists=.env --test --test-name-pattern="resource changes roll back" tests/api-access.test.ts`
Expected: PASS.

- [ ] **Step 5: Point browser routes at the module**

In `server/app.ts`:

1. Add the import next to `import { createUploads } from "./uploads";`:

```ts
import {
  createResourceOperations,
  resourceDescription,
  resourceName,
} from "./resources";
```

2. Delete the `const name = z ... ;` block (lines 54-62). Keep `const id = z.string().uuid();`.

3. After `const uploads = createUploads(store, { rateLimits: options.rateLimits });` add:

```ts
  const resources = createResourceOperations(store);
```

4. Replace the whole `app.post("/api/folders", mutation(...))` handler body with:

```ts
  app.post(
    "/api/folders",
    mutation(async (req) => {
      const input = z
        .object({
          name: resourceName,
          description: resourceDescription,
          parentId: id.nullable().default(null),
        })
        .parse(req.body);
      return {
        status: 201,
        body: await resources.createFolder(actor(req), input),
      };
    }),
  );
```

5. Replace `app.patch("/api/resources/:id", ...)` with:

```ts
  app.patch(
    "/api/resources/:id",
    mutation(async (req) => {
      const input = z
        .object({ name: resourceName, description: resourceDescription })
        .parse(req.body);
      await resources.rename(actor(req), id.parse(req.params.id), input);
      return {
        status: 200,
        body: { ok: true },
      };
    }),
  );
```

6. Replace `app.post("/api/resources/:id/move", ...)` with:

```ts
  app.post(
    "/api/resources/:id/move",
    mutation(async (req) => {
      const { parentId } = z
        .object({ parentId: id.nullable() })
        .strict()
        .parse(req.body);
      await resources.move(actor(req), id.parse(req.params.id), parentId);
      return { status: 200, body: { ok: true } };
    }),
  );
```

7. Delete `async function deleteResources(...) { ... }` and change the two delete routes to:

```ts
  app.post(
    "/api/resources/delete-batch",
    mutation(async (req) => {
      const { ids } = z
        .object({ ids: z.array(id).min(1).max(100) })
        .strict()
        .parse(req.body);
      const count = await resources.remove(actor(req), [...new Set(ids)]);
      return { status: 200, body: { ok: true, count } };
    }),
  );
  app.delete(
    "/api/resources/:id",
    mutation(async (req) => {
      await resources.remove(actor(req), [id.parse(req.params.id)]);
      return {
        status: 200,
        body: { ok: true },
      };
    }),
  );
```

8. Run `grep -n "deleteResources\|[^.]\bname,$" server/app.ts` and confirm no leftover references to the removed helpers. Remove `randomUUID` from the `node:crypto` import only if `pnpm check` reports it unused.

- [ ] **Step 6: Typecheck and run regression suites**

Run: `pnpm check`
Expected: no errors.

Run: `npx tsx --env-file-if-exists=.env --test tests/api-access.test.ts tests/security.test.ts tests/organization.test.ts tests/storage.test.ts tests/chat.test.ts`
Expected: all pass except tests on the pre-existing failure list in **Test Environment**.

- [ ] **Step 7: Commit**

```bash
git add server/resources.ts server/app.ts tests/api-access.test.ts
git commit -m "$(cat <<'EOF'
Extract library resource operations into a shared module

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Add the `documents:manage` scope

**Files:**
- Modify: `shared/api-access.ts`
- Modify: `server/auth.ts:222-227`
- Modify: `server/api-keys.ts:26-31`
- Modify: `server/external-access.ts:250-255` (`delegatedPrincipal`)
- Test: `tests/api-access.test.ts` (append)

**Interfaces:**
- Produces: `ApiScope` includes `"documents:manage"`; API key principals and delegated principals carry `documents:manage` when the key's stored permissions include `documents: ["manage"]`.

- [ ] **Step 1: Write the failing test**

```ts
test("new API keys include documents:manage while older keys keep their permissions", async () => {
  const { createApiKeys } = await import("../server/api-keys");
  const { createExternalAccess } = await import("../server/external-access");
  const { createUploads } = await import("../server/uploads");
  const keys = createApiKeys(runtime.auth);
  const created = await key();
  const current = await keys.authenticate(created.token);
  assert.ok(current.scopes.includes("documents:manage"));
  const older = await runtime.auth.api.createApiKey({
    body: {
      userId,
      name: "Older",
      permissions: { documents: ["read", "write"], search: ["read"] },
      expiresIn: 86400,
    },
  });
  assert.deepEqual((await keys.authenticate(older.key)).scopes.sort(), [
    "documents:read",
    "documents:write",
    "search:read",
  ]);
  const access = createExternalAccess(
    runtime.store,
    runtime.auth,
    runtime.providers,
    origin,
    async () => {
      throw new Error("Token validation is not used for keys");
    },
    false,
    createUploads(runtime.store),
  );
  const delegated = await access.delegatedPrincipal(
    JSON.stringify({ principal: current }),
  );
  assert.ok(delegated.scopes.includes("documents:manage"));
  const metadata = await (
    await fetch(base + "/.well-known/oauth-protected-resource/api/v1")
  ).json();
  assert.ok(metadata.scopes_supported.includes("documents:manage"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --env-file-if-exists=.env --test --test-name-pattern="documents:manage while older" tests/api-access.test.ts`
Expected: FAIL at `assert.ok(current.scopes.includes("documents:manage"))`.

- [ ] **Step 3: Implement**

`shared/api-access.ts`:

```ts
export const apiScopes = [
  "search:read",
  "documents:read",
  "documents:write",
  "documents:manage",
] as const;
export type ApiScope = (typeof apiScopes)[number];
export const scopeLabels: Record<ApiScope, string> = {
  "search:read": "Search documents",
  "documents:read": "Read documents and sections",
  "documents:write": "Upload private documents",
  "documents:manage": "Organize, rename, move, and delete documents",
};
```

`server/auth.ts`, inside `apiKey({ permissions: { defaultPermissions: ... } })`:

```ts
          defaultPermissions: {
            documents: ["read", "write", "manage"],
            search: ["read"],
          },
```

`server/api-keys.ts`, after the `documents:write` push:

```ts
      if (permissions?.documents?.includes("write"))
        scopes.push("documents:write");
      if (permissions?.documents?.includes("manage"))
        scopes.push("documents:manage");
```

`server/external-access.ts`, in `delegatedPrincipal`, replace the key scope mapping:

```ts
      scopes = ["documents", "search"].flatMap((resource) =>
        ["read", "write", "manage"]
          .filter((operation) => permissions?.[resource]?.includes(operation))
          .map((operation) => `${resource}:${operation}`),
      );
```

- [ ] **Step 4: Run tests**

Run: `npx tsx --env-file-if-exists=.env --test tests/api-access.test.ts`
Expected: the new test passes. The MCP tool-name assertions still pass (no new tools yet). All 21 tests pass.

Run: `pnpm check`
Expected: no errors (the `scopeLabels` record now requires the new key; `src/components/oauth-consent.tsx` and `src/components/mcp.tsx` read it generically).

- [ ] **Step 5: Commit**

```bash
git add shared/api-access.ts server/auth.ts server/api-keys.ts server/external-access.ts tests/api-access.test.ts
git commit -m "$(cat <<'EOF'
Add documents:manage scope for new API keys and OAuth consent

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `GET /api/v1/resources`

**Files:**
- Modify: `server/external-access.ts`
- Test: `tests/api-access.test.ts` (append)

**Interfaces:**
- Consumes: `createResourceOperations(store).list` from Task 1.
- Produces (exported from `server/external-access.ts`):
  - `export const listResourcesInput` — `{ organizationId: uuid, parentId?: uuid, kind?: "document" | "folder" }`, strict
  - `access.listResources(principal: Principal, body: unknown): Promise<{ resources: ApiResource[] }>` where `ApiResource = { id, kind, name, description, parentId, access, mime, size, status, error, pages, created, canWrite, canShare, url }`

- [ ] **Step 1: Write the failing test**

```ts
test("REST lists readable resources with folder and kind filters", async () => {
  const created = await key();
  const folderId = randomUUID();
  const nestedId = randomUUID();
  const createdAt = new Date().toISOString();
  await runtime.store.run(
    "INSERT INTO resources(id,org_id,owner_id,kind,name,created) VALUES(?,?,?,'folder',?,?)",
    folderId,
    orgId,
    userId,
    "Listing folder",
    createdAt,
  );
  await runtime.store.run(
    "INSERT INTO resources(id,org_id,owner_id,parent_id,kind,name,access,created) VALUES(?,?,?,?,'document',?,'inherit',?)",
    nestedId,
    orgId,
    userId,
    folderId,
    "Nested",
    createdAt,
  );
  try {
    const list = (query = "", token = created.token) =>
      request(`/api/v1/resources?organizationId=${orgId}${query}`, token);
    const response = await list();
    assert.equal(response.status, 200, await response.clone().text());
    const all = (await response.json()).resources;
    const ids = all.map((r: any) => r.id);
    for (const visible of [ownId, sharedId, emptyFolderId, folderId, nestedId])
      assert.ok(ids.includes(visible), visible);
    assert.ok(!ids.includes(privateId));
    assert.ok(!ids.includes(foreignId));
    const shared = all.find((r: any) => r.id === sharedId);
    assert.equal(shared.canWrite, false);
    assert.equal(shared.canShare, false);
    assert.equal("parsed" in shared, false);
    const folder = all.find((r: any) => r.id === folderId);
    assert.equal(folder.kind, "folder");
    assert.equal(folder.mime, "");
    assert.equal(folder.size, 0);
    assert.equal(folder.pages, 0);
    assert.equal(folder.url, `${origin}/library/folders/${folderId}`);
    const folders = (await (await list("&kind=folder")).json()).resources;
    assert.ok(folders.length > 0);
    assert.ok(folders.every((r: any) => r.kind === "folder"));
    const children = (
      await (await list(`&parentId=${folderId}`)).json()
    ).resources;
    assert.deepEqual(
      children.map((r: any) => r.id),
      [nestedId],
    );
    assert.equal(children[0].parentId, folderId);
    assert.equal(children[0].canWrite, true);
    assert.equal(children[0].canShare, true);
    assert.equal(children[0].url, `${origin}/library/documents/${nestedId}`);
    assert.equal((await list(`&parentId=${ownId}`)).status, 404);
    assert.equal((await list(`&parentId=${privateId}`)).status, 404);
    assert.equal((await list(`&parentId=${foreignId}`)).status, 404);
    assert.equal((await list("&kind=other")).status, 400);
    assert.equal(
      (
        await request(
          `/api/v1/resources?organizationId=${foreignOrgId}`,
          created.token,
        )
      ).status,
      404,
    );
    const searchOnly = await runtime.auth.api.createApiKey({
      body: {
        userId,
        name: "Search only",
        permissions: { search: ["read"] },
        expiresIn: 86400,
      },
    });
    assert.equal((await list("", searchOnly.key)).status, 403);
  } finally {
    await runtime.store.run(
      "DELETE FROM resources WHERE id=ANY(?::text[])",
      [nestedId, folderId],
    );
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --env-file-if-exists=.env --test --test-name-pattern="REST lists readable" tests/api-access.test.ts`
Expected: FAIL, first status assertion is 404 (route does not exist).

- [ ] **Step 3: Implement**

In `server/external-access.ts`:

1. Extend the `./db` import with `resourcePermissionsBatch` and `type Resource`, and add:

```ts
import {
  createResourceOperations,
  resourceDescription,
  resourceName,
  type ResourceChange,
} from "./resources";
```

2. Next to `documentPath`, add:

```ts
const folderPath = (id: string) =>
  `/library/folders/${encodeURIComponent(id)}`;
```

3. After `fetchInput`, add:

```ts
export const listResourcesInput = z
  .object({
    organizationId,
    parentId: z.string().uuid().optional(),
    kind: z.enum(["document", "folder"]).optional(),
  })
  .strict();
```

4. Inside `createExternalAccess`, after `const keys = createApiKeys(auth);`:

```ts
  const resources = createResourceOperations(store);
```

5. Before `function outline(`, add:

```ts
  function resourceView(r: Resource, canWrite: boolean, canShare: boolean) {
    const folder = r.kind === "folder";
    return {
      id: r.id,
      kind: r.kind,
      name: r.name,
      description: r.description,
      parentId: r.parent_id,
      access: r.access,
      mime: folder ? "" : (r.mime ?? ""),
      size: folder ? 0 : Number(r.size),
      status: r.status,
      error: r.error,
      pages: !folder && r.parsed ? JSON.parse(r.parsed).pages : 0,
      created: r.created,
      canWrite,
      canShare,
      url: `${origin}${folder ? folderPath(r.id) : documentPath(r.id)}`,
    };
  }
  async function listResources(principal: Principal, body: unknown) {
    requireScope(principal, "documents:read");
    const input = listResourcesInput.parse(body);
    const a = await actor(principal, input.organizationId);
    const rows = await resources.list(a, input);
    const allowed = await resourcePermissionsBatch(
      store,
      a,
      rows.flatMap(({ id }) => [
        { id, action: "write" as const },
        { id, action: "share" as const },
      ]),
    );
    return {
      resources: rows.map((r, index) =>
        resourceView(r, allowed[index * 2], allowed[index * 2 + 1]),
      ),
    };
  }
```

6. After the `router.get("/documents/:id", ...)` route, add:

```ts
  router.get("/resources", async (req, res) =>
    res.json(
      await listResources(await authenticate(req, "/api/v1"), {
        organizationId: req.query.organizationId,
        ...(req.query.parentId ? { parentId: req.query.parentId } : {}),
        ...(req.query.kind ? { kind: req.query.kind } : {}),
      }),
    ),
  );
```

7. Add `listResources` to the returned object.

- [ ] **Step 4: Run tests**

Run: `npx tsx --env-file-if-exists=.env --test tests/api-access.test.ts`
Expected: all pass.

Run: `pnpm check`
Expected: no errors. (`ResourceChange`, `resourceName`, and `resourceDescription` are used in Task 4; if `pnpm check` flags them unused, import them in Task 4 instead.)

- [ ] **Step 5: Commit**

```bash
git add server/external-access.ts tests/api-access.test.ts
git commit -m "$(cat <<'EOF'
List library resources through the REST API

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: REST folder creation, rename, move, and delete

**Files:**
- Modify: `server/external-access.ts`
- Test: `tests/api-access.test.ts` (append)

**Interfaces:**
- Consumes: `resources.createFolder|rename|move|remove` and `ResourceChange` from Task 1; `documents:manage` from Task 2.
- Produces (exported from `server/external-access.ts`):
  - `createFolderInput` `{ organizationId, name, description?, parentId?: uuid | null }`
  - `renameResourceInput` `{ organizationId, id: uuid, name, description? }`
  - `moveResourceInput` `{ organizationId, id: uuid, parentId: uuid | null }`
  - `deleteResourceInput` `{ organizationId, id: uuid }`
  - Methods, all `(principal: Principal, body: unknown, revalidate: () => Promise<Principal>)`:
    - `createFolder` → `{ id: string; url: string }`
    - `renameResource` → `{ ok: true }`
    - `moveResource` → `{ ok: true }`
    - `deleteResource` → `{ ok: true; count: number }`

- [ ] **Step 1: Write the failing test**

The test uses the existing `uploadRequest(token, blob)` helper defined earlier in this file (used by the REST upload tests).

```ts
test("REST manages folders and documents with documents:manage and web permissions", async () => {
  await runtime.store.run("DELETE FROM upload_usage");
  const created = await key();
  const call = (
    path: string,
    method: string,
    body?: unknown,
    token = created.token,
  ) =>
    request(
      `/api/v1${path}${path.includes("?") ? "&" : "?"}organizationId=${orgId}`,
      token,
      method,
      body,
    );
  const row = (id: string) =>
    runtime.store.one<any>("SELECT * FROM resources WHERE id=?", id);
  const folder = await call("/folders", "POST", { name: "Managed" });
  assert.equal(folder.status, 201, await folder.clone().text());
  const { id: folderId, url } = await folder.json();
  assert.equal(url, `${origin}/library/folders/${folderId}`);
  assert.equal((await row(folderId)).owner_id, userId);
  assert.equal((await row(folderId)).access, "restricted");
  const child = await call("/folders", "POST", {
    name: "Child",
    parentId: folderId,
  });
  assert.equal(child.status, 201, await child.clone().text());
  const { id: childId } = await child.json();
  for (const name of ["a/b", "tab\there", "x".repeat(161), " "])
    assert.equal((await call("/folders", "POST", { name })).status, 400, name);
  assert.equal(
    (await call("/folders", "POST", { name: "Under a document", parentId: ownId }))
      .status,
    400,
  );
  assert.equal(
    (await call("/folders", "POST", { name: "Hidden", parentId: privateId }))
      .status,
    404,
  );
  const renamed = await call(`/resources/${folderId}`, "PATCH", {
    name: "Renamed",
    description: "Notes",
  });
  assert.equal(renamed.status, 200, await renamed.clone().text());
  assert.equal((await row(folderId)).name, "Renamed");
  assert.equal((await row(folderId)).description, "Notes");
  assert.equal(
    (await call(`/resources/${sharedId}`, "PATCH", { name: "Nope" })).status,
    404,
  );
  assert.equal(
    (await call(`/resources/${folderId}/move`, "POST", { parentId: childId }))
      .status,
    400,
  );
  assert.equal(
    (await call(`/resources/${folderId}/move`, "POST", { parentId: folderId }))
      .status,
    400,
  );
  assert.equal(
    (await call(`/resources/${childId}/move`, "POST", { parentId: ownId }))
      .status,
    400,
  );
  const inheritingId = randomUUID();
  await runtime.store.run(
    "INSERT INTO resources(id,org_id,owner_id,parent_id,kind,name,access,created) VALUES(?,?,?,?,'document',?,'inherit',?)",
    inheritingId,
    orgId,
    userId,
    childId,
    "Inheriting",
    new Date().toISOString(),
  );
  const toRoot = await call(`/resources/${inheritingId}/move`, "POST", {
    parentId: null,
  });
  assert.equal(toRoot.status, 200, await toRoot.clone().text());
  assert.equal((await row(inheritingId)).parent_id, null);
  assert.equal((await row(inheritingId)).access, "restricted");
  assert.equal(
    (
      await call(`/resources/${inheritingId}/move`, "POST", {
        parentId: childId,
      })
    ).status,
    200,
  );
  assert.equal((await row(inheritingId)).parent_id, childId);
  assert.equal(
    (await call(`/resources/${sharedId}/move`, "POST", { parentId: null }))
      .status,
    404,
  );
  const othersDocument = randomUUID();
  await runtime.store.run(
    "INSERT INTO resources(id,org_id,owner_id,parent_id,kind,name,access,created) VALUES(?,?,?,?,'document',?,'inherit',?)",
    othersDocument,
    orgId,
    otherId,
    folderId,
    "Owned by another member",
    new Date().toISOString(),
  );
  assert.equal((await call(`/resources/${folderId}`, "DELETE")).status, 404);
  assert.ok(await row(folderId));
  assert.ok(await row(childId));
  await runtime.store.run("DELETE FROM resources WHERE id=?", othersDocument);
  const removed = await call(`/resources/${folderId}`, "DELETE");
  assert.equal(removed.status, 200, await removed.clone().text());
  assert.deepEqual(await removed.json(), { ok: true, count: 3 });
  for (const gone of [folderId, childId, inheritingId])
    assert.equal(await row(gone), undefined);
  assert.equal((await call(`/resources/${folderId}`, "DELETE")).status, 404);
  assert.deepEqual(
    (
      await runtime.store.all<{ action: string }>(
        "SELECT action FROM audit WHERE resource_id=? ORDER BY action",
        folderId,
      )
    ).map(({ action }) => action),
    ["api.folder.create", "api.resource.delete", "api.resource.update"],
  );
  const uploaded = await uploadRequest(
    created.token,
    new Blob(["Queued text"], { type: "application/octet-stream" }),
  );
  assert.equal(uploaded.status, 201, await uploaded.clone().text());
  const { id: queuedId } = await uploaded.json();
  assert.equal((await call(`/resources/${queuedId}`, "DELETE")).status, 200);
  assert.equal(await row(queuedId), undefined);
  assert.equal((await call(`/resources/${foreignId}`, "DELETE")).status, 404);
  assert.equal(
    (
      await request(
        `/api/v1/resources/${foreignId}?organizationId=${foreignOrgId}`,
        created.token,
        "DELETE",
      )
    ).status,
    404,
  );
  const older = await runtime.auth.api.createApiKey({
    body: {
      userId,
      name: "Before manage",
      permissions: { documents: ["read", "write"], search: ["read"] },
      expiresIn: 86400,
    },
  });
  for (const [path, method, body] of [
    ["/folders", "POST", { name: "Denied" }],
    [`/resources/${ownId}`, "PATCH", { name: "Denied" }],
    [`/resources/${ownId}/move`, "POST", { parentId: null }],
    [`/resources/${ownId}`, "DELETE", undefined],
  ] as const)
    assert.equal(
      (await call(path, method, body, older.key)).status,
      403,
      `${method} ${path}`,
    );
  assert.ok(await row(ownId));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --env-file-if-exists=.env --test --test-name-pattern="REST manages folders" tests/api-access.test.ts`
Expected: FAIL, `POST /folders` returns 404.

- [ ] **Step 3: Implement**

In `server/external-access.ts`:

1. After `listResourcesInput`, add:

```ts
export const createFolderInput = z
  .object({
    organizationId,
    name: resourceName,
    description: resourceDescription,
    parentId: z.string().uuid().nullable().default(null),
  })
  .strict();
export const renameResourceInput = z
  .object({
    organizationId,
    id: z.string().uuid(),
    name: resourceName,
    description: resourceDescription,
  })
  .strict();
export const moveResourceInput = z
  .object({
    organizationId,
    id: z.string().uuid(),
    parentId: z.string().uuid().nullable(),
  })
  .strict();
export const deleteResourceInput = z
  .object({ organizationId, id: z.string().uuid() })
  .strict();
```

2. After `listResources`, add:

```ts
  async function manage<T>(
    principal: Principal,
    orgId: string,
    revalidate: () => Promise<Principal>,
    work: (a: Actor, options: ResourceChange) => Promise<T>,
  ) {
    const a = await actor(principal, orgId);
    return work(a, {
      auditPrefix: "api.",
      revalidate: async () => {
        const current = await revalidate();
        requireScope(current, "documents:manage");
        await actor(current, orgId);
      },
    });
  }
  async function createFolder(
    principal: Principal,
    body: unknown,
    revalidate: () => Promise<Principal>,
  ) {
    requireScope(principal, "documents:manage");
    const { organizationId: orgId, ...input } = createFolderInput.parse(body);
    const { id } = await manage(principal, orgId, revalidate, (a, options) =>
      resources.createFolder(a, input, options),
    );
    return { id, url: `${origin}${folderPath(id)}` };
  }
  async function renameResource(
    principal: Principal,
    body: unknown,
    revalidate: () => Promise<Principal>,
  ) {
    requireScope(principal, "documents:manage");
    const { organizationId: orgId, id, ...input } =
      renameResourceInput.parse(body);
    await manage(principal, orgId, revalidate, (a, options) =>
      resources.rename(a, id, input, options),
    );
    return { ok: true };
  }
  async function moveResource(
    principal: Principal,
    body: unknown,
    revalidate: () => Promise<Principal>,
  ) {
    requireScope(principal, "documents:manage");
    const input = moveResourceInput.parse(body);
    await manage(principal, input.organizationId, revalidate, (a, options) =>
      resources.move(a, input.id, input.parentId, options),
    );
    return { ok: true };
  }
  async function deleteResource(
    principal: Principal,
    body: unknown,
    revalidate: () => Promise<Principal>,
  ) {
    requireScope(principal, "documents:manage");
    const input = deleteResourceInput.parse(body);
    const count = await manage(
      principal,
      input.organizationId,
      revalidate,
      (a, options) => resources.remove(a, [input.id], options),
    );
    return { ok: true, count };
  }
```

3. After the `router.get("/resources", ...)` route, add:

```ts
  const managed =
    (
      handler: (
        principal: Principal,
        body: unknown,
        revalidate: () => Promise<Principal>,
      ) => Promise<object>,
      body: (req: Request) => object,
      status = 200,
    ) =>
    async (req: Request, res: import("express").Response) =>
      res
        .status(status)
        .json(
          await handler(
            await authenticate(req, "/api/v1"),
            { ...body(req), organizationId: req.query.organizationId },
            () => authenticate(req, "/api/v1"),
          ),
        );
  router.post(
    "/folders",
    managed(createFolder, (req) => ({ ...req.body }), 201),
  );
  router.patch(
    "/resources/:id",
    managed(renameResource, (req) => ({ ...req.body, id: req.params.id })),
  );
  router.post(
    "/resources/:id/move",
    managed(moveResource, (req) => ({ ...req.body, id: req.params.id })),
  );
  router.delete(
    "/resources/:id",
    managed(deleteResource, (req) => ({ id: req.params.id })),
  );
```

4. Add `createFolder`, `renameResource`, `moveResource`, and `deleteResource` to the returned object.

- [ ] **Step 4: Run tests**

Run: `npx tsx --env-file-if-exists=.env --test tests/api-access.test.ts`
Expected: all pass. If the `"tab\there"` name case returns 201, the control-character refine is not applied: confirm `createFolderInput` uses `resourceName` from `server/resources.ts`.

Run: `pnpm check`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/external-access.ts tests/api-access.test.ts
git commit -m "$(cat <<'EOF'
Create, rename, move, and delete library resources through the REST API

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: MCP resource tools

**Files:**
- Modify: `server/mcp.ts`
- Modify: `tests/api-access.test.ts` (tool-name assertions near lines 469, 757, and 964-975; append a new test)

**Interfaces:**
- Consumes: `listResourcesInput`, `createFolderInput`, `renameResourceInput`, `moveResourceInput`, `deleteResourceInput`, `access.listResources`, `access.createFolder`, `access.renameResource`, `access.moveResource`, `access.deleteResource` from Tasks 3-4.
- Produces: MCP tools `list_resources`, `create_folder`, `rename_resource`, `move_resource`, `delete_resource`.

- [ ] **Step 1: Write the failing test and update existing tool lists**

Append:

```ts
test("MCP resource tools follow scopes and mark deletion destructive", async () => {
  const created = await key();
  const rpc = async (id: number, method: string, params?: object, token = created.token) =>
    (
      await request("/mcp", token, "POST", {
        jsonrpc: "2.0",
        id,
        method,
        ...(params ? { params } : {}),
      })
    ).json();
  const tools = new Map<string, any>(
    (await rpc(200, "tools/list")).result.tools.map((tool: any) => [
      tool.name,
      tool,
    ]),
  );
  assert.equal(tools.get("list_resources").annotations.readOnlyHint, true);
  assert.equal(tools.get("create_folder").annotations.readOnlyHint, false);
  assert.equal(tools.get("rename_resource").annotations.idempotentHint, true);
  assert.equal(tools.get("move_resource").annotations.idempotentHint, true);
  assert.equal(tools.get("delete_resource").annotations.destructiveHint, true);
  assert.equal(tools.get("delete_resource").annotations.idempotentHint, false);
  const call = async (id: number, name: string, args: object) =>
    (
      await rpc(id, "tools/call", {
        name,
        arguments: { organizationId: orgId, ...args },
      })
    ).result;
  const outer = await call(201, "create_folder", { name: "MCP outer" });
  assert.equal(outer.isError, undefined, JSON.stringify(outer));
  const inner = await call(202, "create_folder", { name: "MCP inner" });
  const outerId = outer.structuredContent.id;
  const innerId = inner.structuredContent.id;
  const renamed = await call(203, "rename_resource", {
    id: innerId,
    name: "MCP renamed",
  });
  assert.equal(renamed.isError, undefined, JSON.stringify(renamed));
  const moved = await call(204, "move_resource", {
    id: innerId,
    parentId: outerId,
  });
  assert.equal(moved.isError, undefined, JSON.stringify(moved));
  const listed = await call(205, "list_resources", { parentId: outerId });
  assert.deepEqual(
    listed.structuredContent.resources.map((r: any) => [r.id, r.name]),
    [[innerId, "MCP renamed"]],
  );
  const removed = await call(206, "delete_resource", { id: outerId });
  assert.equal(removed.isError, undefined, JSON.stringify(removed));
  assert.equal(removed.structuredContent.count, 2);
  assert.equal(
    (await call(207, "delete_resource", { id: outerId })).isError,
    true,
  );
  const older = await runtime.auth.api.createApiKey({
    body: {
      userId,
      name: "MCP before manage",
      permissions: { documents: ["read", "write"], search: ["read"] },
      expiresIn: 86400,
    },
  });
  const names = (await rpc(208, "tools/list", undefined, older.key)).result.tools.map(
    (tool: any) => tool.name,
  );
  assert.ok(names.includes("list_resources"));
  for (const name of [
    "create_folder",
    "rename_resource",
    "move_resource",
    "delete_resource",
  ])
    assert.ok(!names.includes(name), name);
});
```

Update the three exact tool-name assertions:

- Near line 469 (full-access key through the official client), the sorted list becomes:

```ts
      assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
        "answer",
        "cancel_run",
        "create_folder",
        "delete_resource",
        "fetch",
        "get_run",
        "list_organizations",
        "list_resources",
        "list_runs",
        "move_resource",
        "rename_resource",
        "search",
        "upload_document",
      ]);
```

- Near line 757 (OAuth `search:read documents:read`):

```ts
    [
      "answer",
      "cancel_run",
      "fetch",
      "get_run",
      "list_organizations",
      "list_resources",
      "list_runs",
      "search",
    ],
```

- Near lines 964-975 (OAuth `documents:read` only), both lists become `["fetch", "list_organizations", "list_resources"]`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --env-file-if-exists=.env --test tests/api-access.test.ts`
Expected: FAIL in the new MCP test (`tools.get("list_resources")` is undefined) and in the three updated tool-list assertions.

- [ ] **Step 3: Implement**

In `server/mcp.ts`, extend the import:

```ts
import {
  createFolderInput,
  deleteResourceInput,
  fetchInput,
  listResourcesInput,
  moveResourceInput,
  renameResourceInput,
  type createExternalAccess,
} from "./external-access";
```

After the `fetch` tool registration and before `upload_document`, add:

```ts
              if (principal.scopes.includes("documents:read"))
                server.registerTool(
                  "list_resources",
                  {
                    description:
                      "List folders and documents you can read in an organization, newest first. Optional parentId lists only that folder's direct children; optional kind is document or folder. Use fetch to read a document's text.",
                    inputSchema: listResourcesInput,
                    annotations,
                  },
                  (input) =>
                    respond(() => access.listResources(principal, input)),
                );
              if (principal.scopes.includes("documents:manage"))
                for (const [name, description, schema, handler, hints] of [
                  [
                    "create_folder",
                    "Create a Private folder you own. Optional parentId must be a folder you can write to.",
                    createFolderInput,
                    access.createFolder,
                    { idempotentHint: false },
                  ],
                  [
                    "rename_resource",
                    "Rename a document or folder and replace its description. Requires write access.",
                    renameResourceInput,
                    access.renameResource,
                    { idempotentHint: true },
                  ],
                  [
                    "move_resource",
                    "Move a document or folder into another folder, or to the library root with parentId null. Requires ownership of the item and write access to the destination.",
                    moveResourceInput,
                    access.moveResource,
                    { idempotentHint: true },
                  ],
                  [
                    "delete_resource",
                    "Permanently delete a document or folder you own. Folders are deleted with everything inside them, and deletion cannot be undone. Confirm with the user before calling.",
                    deleteResourceInput,
                    access.deleteResource,
                    { idempotentHint: false, destructiveHint: true },
                  ],
                ] as const)
                  server.registerTool(
                    name,
                    {
                      description,
                      inputSchema: schema,
                      annotations: {
                        readOnlyHint: false,
                        destructiveHint: false,
                        openWorldHint: false,
                        ...hints,
                      },
                    },
                    (input: unknown) =>
                      respond(() => handler(principal, input, revalidate)),
                  );
```

- [ ] **Step 4: Run tests**

Run: `npx tsx --env-file-if-exists=.env --test tests/api-access.test.ts`
Expected: all pass.

Run: `pnpm check`
Expected: no errors. If `registerTool` rejects the union of schemas in the loop, replace the loop with four explicit `server.registerTool` calls using the same names, descriptions, schemas, and annotations.

- [ ] **Step 5: Commit**

```bash
git add server/mcp.ts tests/api-access.test.ts
git commit -m "$(cat <<'EOF'
Expose library resource tools through MCP

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Documentation, in-app guides, and final verification

**Files:**
- Modify: `docs/api-access.md`
- Modify: `docs/security.md:61`
- Modify: `src/components/api-usage-guide.tsx`
- Modify: `src/components/mcp-usage-guide.tsx`

**Interfaces:**
- Consumes: final routes, tool names, and scope from Tasks 2-5.

- [ ] **Step 1: Update `docs/api-access.md`**

1. In the second paragraph, replace "New keys can read and search accessible content and upload Private documents. Keys created before upload support remain read-only; create a new key to enable uploads." with:

> New keys can read and search accessible content, upload Private documents, and organize, rename, move, and delete resources their creator is permitted to change. Keys keep the permissions they were created with: keys created before upload support remain read-only, and keys created before library management cannot change existing resources. Create a new key to gain newer permissions.

2. In **REST API**, replace "Browser endpoints retain their existing session and origin requirements; API keys can upload documents through the endpoint below. They cannot change permissions, manage keys, or modify existing resources." with:

> Browser endpoints retain their existing session and origin requirements and do not accept API keys. Keys can upload documents and manage library resources through the endpoints below. They cannot change sharing or access, manage keys, or change organization settings.

3. After the upload section (before "Any file extension is accepted..."'s following paragraph about errors), insert a new subsection:

````markdown
### Library management

`GET /api/v1/resources?organizationId=<organization UUID>` lists folders and documents you can read, newest first. Optional `parentId` lists only a folder's direct children, and optional `kind` is `document` or `folder`. Each item has `id`, `kind`, `name`, `description`, `parentId`, `access`, `mime`, `size`, `status`, `error`, `pages`, `created`, `canWrite`, `canShare`, and `url`. Parsed text is not included; use the document fetch above. Requires `documents:read`.

The following require `documents:manage` and take `organizationId` in the query string:

| Request | Body | Permission |
| --- | --- | --- |
| `POST /api/v1/folders` | `{ "name", "description"?, "parentId"? }` | Write access to `parentId` |
| `PATCH /api/v1/resources/:id` | `{ "name", "description"? }` | Write access |
| `POST /api/v1/resources/:id/move` | `{ "parentId": "<folder UUID>" \| null }` | Ownership of the item and write access to the destination |
| `DELETE /api/v1/resources/:id` | None | Ownership of the item and everything inside it |

Folder creation returns HTTP 201 with `id` and `url`; new folders are owned by the caller and start Private. Rename and move return `{ "ok": true }`; omitting `description` clears it. Moving a folder into itself or a descendant returns 400, and moving an item to the root makes inherited access Private. Delete returns `{ "ok": true, "count": <deleted resources> }`. Deleting a folder deletes everything inside it and cannot be undone; if any item inside belongs to someone else, nothing is deleted and the request returns 404. Names are limited to 160 characters without slashes or control characters.

```sh
curl --fail-with-body -X DELETE \
  "$JEVBOX_ORIGIN/api/v1/resources/$DOCUMENT_ID?organizationId=$ORGANIZATION_ID" \
  -H "Authorization: Bearer $JEVBOX_API_KEY"
```
````

4. In the **MCP** tool table, add rows:

```markdown
| `list_resources`     | `organizationId`, optional `parentId`, `kind`                                      |
| `create_folder`      | `organizationId`, `name`, optional `description`, `parentId`                       |
| `rename_resource`    | `organizationId`, `id`, `name`, optional `description`                             |
| `move_resource`      | `organizationId`, `id`, `parentId` (folder UUID or null)                           |
| `delete_resource`    | `organizationId`, `id`                                                             |
```

and after "New API keys advertise the read tools and `upload_document`." add: "Keys and OAuth grants with `documents:manage` also advertise the four management tools; `delete_resource` is marked destructive."

5. In the OAuth scope table, add:

```markdown
| `documents:manage` | Create folders and rename, move, or delete resources the user may change; does not change sharing |
```

and change the `documents:write` row's operations to "Upload a new Private document; does not edit, delete, or share content".

- [ ] **Step 2: Update `docs/security.md`**

On line 61, replace "read-only key permissions" with "per-key scopes fixed at creation". Append to the same paragraph: "Keys and OAuth grants with `documents:manage` can change library resources through the same owner and write checks as the web app, but never sharing or access settings."

- [ ] **Step 3: Update `src/components/api-usage-guide.tsx`**

1. Change the intro paragraph to:

```tsx
      <p className="muted">
        Read your organizations, search documents, fetch source text, upload
        Private documents, and organize your library with your current
        permissions.
      </p>
```

2. Change the paragraph starting "New API keys include upload access." to:

```tsx
        <p>
          New API keys include upload and library management access. Older keys
          keep the permissions they were created with; create a new key for
          newer access. OAuth requires <code>documents:write</code>. Uploaded
          documents belong to you and start Private, including in shared
          folders. Upload cannot edit existing documents or share them.
        </p>
```

3. Insert after the upload `</article>` and before "Limits and errors":

```tsx
      <article className="api-docs-section">
        <h3>5. Manage your library</h3>
        <div className="api-docs-route">
          <Badge variant="success">GET</Badge>
          <code>/resources</code>
        </div>
        <p>
          Lists folders and documents you can read, newest first. Add{" "}
          <code>parentId</code> for one folder’s direct children or{" "}
          <code>kind</code> for only documents or folders.
        </p>
        <RequestCode
          label="List resources · cURL"
          text={`curl --fail-with-body --get "${url}/resources" \\\n  ${authorization} \\\n  --data-urlencode "organizationId=<ORGANIZATION_ID>"`}
          onCopy={onCopy}
        />
        <div className="api-docs-route">
          <Badge variant="warning">POST</Badge>
          <code>/folders</code>
        </div>
        <div className="api-docs-route">
          <Badge variant="info">PATCH</Badge>
          <code>/resources/:id</code>
        </div>
        <div className="api-docs-route">
          <Badge variant="warning">POST</Badge>
          <code>/resources/:id/move</code>
        </div>
        <div className="api-docs-route">
          <Badge variant="error">DELETE</Badge>
          <code>/resources/:id</code>
        </div>
        <p>
          Create folders, rename, move, and delete with{" "}
          <code>organizationId</code> in the query string. Moving and deleting
          require that you own the item; deleting a folder also deletes
          everything inside it and cannot be undone. OAuth requires{" "}
          <code>documents:manage</code>. Sharing settings cannot be changed
          through the API.
        </p>
        <RequestCode
          label="Delete a document · cURL"
          text={`curl --fail-with-body -X DELETE "${url}/resources/<RESOURCE_ID>?organizationId=<ORGANIZATION_ID>" \\\n  ${authorization}`}
          onCopy={onCopy}
        />
      </article>
```

4. In the errors table, change the 403 meaning to `"The key or OAuth token lacks the required scope."`.

- [ ] **Step 4: Update `src/components/mcp-usage-guide.tsx`**

1. Intro paragraph:

```tsx
      <p className="muted">
        Search your library, read source passages, upload Private documents,
        and organize your library with your current permissions.
      </p>
```

2. Add rows to the tools table after `upload_document`:

```tsx
            { name: "list_resources", detail: "List folders and documents." },
            {
              name: "create_folder",
              detail: "Create a Private folder with documents:manage access.",
            },
            {
              name: "rename_resource",
              detail: "Rename a document or folder.",
            },
            {
              name: "move_resource",
              detail: "Move an item you own into another folder.",
            },
            {
              name: "delete_resource",
              detail: "Permanently delete an item you own and its contents.",
            },
```

3. After the "Upload access" article, add:

```tsx
      <article className="api-docs-section">
        <h3>Library management access</h3>
        <p>
          Creating folders, renaming, moving, and deleting need{" "}
          <code>documents:manage</code>. Older keys and grants do not include it;
          reconnect and consent, or create a new API key. Clients should confirm
          with you before calling <code>delete_resource</code>.
        </p>
      </article>
```

- [ ] **Step 5: Full verification**

Run: `pnpm check`
Expected: no errors.

Run: `pnpm test`
Expected: the same 6 failures and 5 cancellations listed in **Test Environment** and nothing else. Every test in `tests/api-access.test.ts` passes.

Run: `pnpm build`
Expected: succeeds.

- [ ] **Step 6: Commit and push to the fork**

```bash
git add docs/api-access.md docs/security.md src/components/api-usage-guide.tsx src/components/mcp-usage-guide.tsx
git commit -m "$(cat <<'EOF'
Document REST and MCP library management

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
git push -u origin feat/api-resource-management
```

Expected: branch published to `SeekST/jevbox`.
