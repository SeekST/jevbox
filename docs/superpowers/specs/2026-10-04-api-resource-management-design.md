# API resource management

Date: 2026-10-04
Status: Draft for review

## Goal

Let API keys and OAuth clients list, create, rename, move, and delete library resources (documents and folders) through `/api/v1` and MCP, with the same permission rules the web app applies today.

Today the public surface can list organizations, search, read one document, and upload a Private document. Everything else is reachable only through browser-session routes under `/api/*`, which reject API keys. Integrations therefore cannot enumerate a library or clean up documents they uploaded.

## Decisions

| Topic | Decision |
| --- | --- |
| Operations | List, create folder, rename, move, delete |
| Surfaces | REST `/api/v1` and MCP `/mcp` |
| Authorization | New scope `documents:manage` for all mutations; listing uses `documents:read` |
| Existing credentials | Do not gain `documents:manage`; create a new key or reconnect OAuth |
| Code organization | Extract shared operations into `server/resources.ts`; browser, REST, and MCP call the same functions |

Out of scope: changing sharing or access (`/api/resources/:id/access`), batch delete, key management, organization settings, chat over REST, and any UI for choosing key scopes.

## Architecture

### `server/resources.ts`

A new module, `createResourceOperations(store)`, owns the resource rules currently inlined in `server/app.ts` route handlers. It takes an `Actor` and never trusts client-supplied organization IDs beyond what `Actor` already carries.

| Function | Permission checks | Source today |
| --- | --- | --- |
| `list(a, { parentId?, kind? })` | `read` on each returned resource, via `resourceAccessBatch` | `GET /api/resources`, `publicResources` |
| `createFolder(a, { name, description, parentId })` | `write` on parent, parent must be a folder | `POST /api/folders` |
| `rename(a, id, { name, description })` | `write` on resource | `PATCH /api/resources/:id` |
| `move(a, id, parentId)` | `share` on resource, `write` on destination, no cycles | `POST /api/resources/:id/move` |
| `remove(a, ids)` | `share` on every selected resource and every descendant | `deleteResources` |

Each mutation writes an audit row. Callers pass the action prefix: browser routes keep `folder.create`, `resource.update`, `resource.move`, `resource.delete`; API callers use `api.folder.create`, `api.resource.update`, `api.resource.move`, `api.resource.delete`.

`server/app.ts` keeps its routes, `mutation()` transaction wrapper, and response shapes, but delegates to these functions. `publicResources` stays in `app.ts` for the browser's richer shape (thumbnails, filing state); the API uses its own compact shape.

### `server/external-access.ts`

New methods on `createExternalAccess`, shared by REST and MCP like `search`, `read`, and `upload`:

- `listResources(principal, input)`
- `createFolder(principal, input, revalidate)`
- `renameResource(principal, input, revalidate)`
- `moveResource(principal, input, revalidate)`
- `deleteResource(principal, input, revalidate)`

Each method calls `requireScope`, resolves the `Actor` with `actor(principal, orgId)`, and runs the operation inside `store.transaction`. Mutations call `revalidate()` and recheck the scope and membership before the transaction commits, so a key revoked mid-request cannot complete the change. This mirrors `upload`.

`createExternalAccess` receives the resource operations as a new parameter from `server/app.ts`.

## REST contract

All routes take `organizationId` in the query string, matching uploads, so membership is checked before reading the body. IDs are UUIDs. Responses for missing or inaccessible resources are 404; missing scopes are 403 with a `WWW-Authenticate` challenge; invalid input is 400.

### `GET /api/v1/resources`

Scope: `documents:read`.

Query: `organizationId`, optional `parentId` (direct children only), optional `kind` (`document` or `folder`). Without `parentId`, returns every readable resource in the organization, newest first.

Response:

```json
{
  "resources": [
    {
      "id": "<uuid>",
      "kind": "document",
      "name": "report.pdf",
      "description": "",
      "parentId": null,
      "access": "restricted",
      "mime": "application/pdf",
      "size": 12345,
      "status": "ready",
      "error": null,
      "pages": 12,
      "created": "2026-10-04T12:00:00.000Z",
      "canWrite": true,
      "canShare": true,
      "url": "<APP_ORIGIN>/library/documents/<uuid>"
    }
  ]
}
```

Folders return `mime: ""`, `size: 0`, `pages: 0`, and `url` `<APP_ORIGIN>/library/folders/<uuid>`. Parsed content is never included; use `GET /api/v1/documents/:id`. A `parentId` the caller cannot read, or that is not a folder, returns 404.

### `POST /api/v1/folders`

Scope: `documents:manage`. Body: `{ "name": string, "description"?: string, "parentId"?: uuid | null }`, using the existing `name` and description validation. Requires `write` on `parentId` when given. Returns 201 `{ "id", "url" }`. The folder is owned by the caller and starts Private (`restricted`) even inside a shared folder, as in the web app.

### `PATCH /api/v1/resources/:id`

Scope: `documents:manage`. Body: `{ "name": string, "description"?: string }`. Requires `write`. Returns `{ "ok": true }`.

### `POST /api/v1/resources/:id/move`

Scope: `documents:manage`. Body: `{ "parentId": uuid | null }`. Requires `share` on the resource and `write` on the destination folder. Rejects moving a folder into itself or a descendant with 400. Moving to the root turns `inherit` access into `restricted`, unchanged from today. Marks automatic filing as manually placed. Returns `{ "ok": true }`.

### `DELETE /api/v1/resources/:id`

Scope: `documents:manage`. Requires `share` on the resource and on every descendant; if any check fails, nothing is deleted. Folders delete recursively. Returns `{ "ok": true, "count": <resources deleted> }`. Stored file cleanup follows the existing deletion path.

## Scopes and credentials

- `shared/api-access.ts`: add `documents:manage` to `apiScopes`, labeled "Organize, rename, move, and delete documents". OAuth consent, connected apps, `scopes_supported`, and challenges pick it up from this list.
- `server/auth.ts`: API key `defaultPermissions.documents` becomes `["read", "write", "manage"]`. Key creation still rejects caller-supplied permissions.
- `server/api-keys.ts` and `delegatedPrincipal` in `server/external-access.ts`: map the `manage` permission to `documents:manage`.
- Existing keys keep their stored permissions and do not gain the scope. Existing OAuth consents do not include it; clients must reconnect and consent.
- No credential can change sharing or access, manage keys, or change organization settings. Browser routes under `/api/*` continue to reject API keys.

## MCP tools

Registered only when the principal holds the scope, following `upload_document`.

| Tool | Scope | Arguments | Annotations |
| --- | --- | --- | --- |
| `list_resources` | `documents:read` | `organizationId`, optional `parentId`, `kind` | read-only, idempotent |
| `create_folder` | `documents:manage` | `organizationId`, `name`, optional `description`, `parentId` | mutation, not idempotent |
| `rename_resource` | `documents:manage` | `organizationId`, `id`, `name`, optional `description` | mutation, idempotent |
| `move_resource` | `documents:manage` | `organizationId`, `id`, `parentId` | mutation, idempotent |
| `delete_resource` | `documents:manage` | `organizationId`, `id` | `destructiveHint: true`, not idempotent |

The `delete_resource` description states that folders delete recursively, that deletion cannot be undone, and that the agent should confirm with the user first. Errors use `isError: true` through the existing `respond` helper.

## Testing

In `tests/api-access.test.ts`, using the existing runtime with PostgreSQL and SpiceDB:

1. Listing returns only readable resources, including grants and ancestor restrictions; `parentId` and `kind` filter correctly; an unreadable `parentId` returns 404.
2. A key without `manage` (permissions set directly in the database, as the migration test does) gets 403 on every mutation; a new key succeeds.
3. A member without `share` cannot delete or move another member's document. Deleting a folder with one descendant the caller cannot share deletes nothing.
4. Moving a folder into itself or a descendant returns 400; moving to the root makes `inherit` resources `restricted`.
5. Revoking the key during a mutation prevents it from committing.
6. MCP advertises the new tools only with matching scopes; `delete_resource` carries `destructiveHint: true`; OAuth grants without `documents:manage` do not see mutation tools.
7. Existing browser-route tests for listing, rename, move, and delete keep passing after extraction.

Verification: `pnpm check` and `pnpm test`.

## Documentation

- `docs/api-access.md`: new REST routes, the `documents:manage` scope and its table row, MCP tools, and the note about existing keys. Replace "They cannot change permissions, manage keys, or modify existing resources" with the new boundary.
- `docs/security.md`: replace "read-only key permissions" with the key permission model.
- `src/components/api-usage-guide.tsx` and `src/components/mcp-usage-guide.tsx`: in-app guides for the new routes and tools.
