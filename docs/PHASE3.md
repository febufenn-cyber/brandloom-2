# Brandloom Phase 3 — Content Operations

## Promise

Plan the campaign, create every deliverable, collect the required assets, resolve feedback and approve the final week in one place. Phase 3 prepares a complete manual publishing handoff; it does not publish through Meta.

## Implemented

- Campaign briefs, dates, temporary facts, capacity and deliverable targets
- Campaign workspaces and portfolio health
- Content workflow state machine
- Operational readiness across copy, assets, checklists and approvals
- Format-specific checklists for static posts, carousels, Reels and Stories
- Structured content storage for slides, shots and frame sequences
- Tasks, deadlines, blocking work and task dependencies
- Private Supabase Storage asset bucket with signed uploads, rights metadata and expiry
- Version-bound sequential approval requests
- Automatic approval invalidation after material edits
- Field-scoped comments and blocking change requests
- Workspace members, roles and expiring single-use invitation tokens
- In-app notifications and activity history
- Content and campaign export packages with SHA-256 checksums
- Operations dashboard, campaign portfolio, work board, asset library, review inbox and team controls

## Workflow states

```text
Idea → Planned → Drafting → Internal review → Ready for approval
     ↘ Blocked      ↖ Changes requested       ↓
                    Approved → Ready to publish → Completed
```

Cancelled and expired content can be restored to planning when appropriate. Invalid jumps are rejected by the API.

## Approval integrity

Every approval stores:

- the content item
- the exact content version
- the current material revision
- the approver and approval type
- the decision and timestamp

A database trigger detects material changes to copy, facts, product, campaign, format, assets instructions or schedule. It increments the material revision, marks older approvals stale and returns previously approved work to review.

## Readiness

`ready_to_publish` requires:

- complete hook, caption, CTA and visual brief
- required asset attachments
- required checklist completion
- all current-version required approvals
- no error-level quality flags
- no blocking tasks
- no unresolved blocking comment threads
- no stale approvals

## Collaboration roles

- Owner
- Admin
- Editor
- Reviewer
- Approver
- Viewer

RLS now grants workspace members scoped access while preserving the original owner policies. Editing and approval capabilities remain role-aware.

## Migrations

Apply in order:

1. `0001_phase1.sql`
2. `0002_phase2_memory.sql`
3. `0003_phase3_operations.sql`
4. `0004_phase3_integrity_triggers.sql`

## Deliberately excluded

- Meta OAuth
- Automatic publishing
- Social performance analytics
- Full visual or video editor
- Public review links
- WhatsApp or Slack notifications
- Ad buying
- Employee performance scoring

These exclusions preserve the Phase 3 boundary: complete and approve the work before granting Brandloom permission to publish it.
