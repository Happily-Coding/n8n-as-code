import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { WorkflowStateTracker } from '../../src/core/services/workflow-state-tracker.js';
import { N8nApiClient } from '../../src/core/services/n8n-api-client.js';
import { IWorkflow } from '../../src/core/types.js';

describe('WorkflowStateTracker archive filtering', () => {
    let tempDir: string | undefined;
    let mockClient: N8nApiClient;

    beforeEach(() => {
        vi.resetAllMocks();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n8nac-archive-filter-'));

        mockClient = {
            getAllWorkflows: vi.fn().mockResolvedValue([
                { id: 'wf-active', name: 'Active Workflow', active: true, isArchived: false } as IWorkflow,
                { id: 'wf-archived', name: 'Archived Workflow', active: false, isArchived: true } as IWorkflow,
            ]),
        } as any;
    });

    afterEach(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        vi.resetAllMocks();
        tempDir = undefined;
    });

    function createTracker() {
        return new WorkflowStateTracker(mockClient, {
            directory: tempDir!,
            syncInactive: false,
            ignoredTags: [],
            projectId: 'test-project',
        });
    }

    it('excludes archived workflows by default', async () => {
        const tracker = createTracker();
        await tracker.refreshRemoteState();
        const results = await tracker.getLightweightList();

        const names = results.map(w => w.name);
        expect(names).toContain('Active Workflow');
        expect(names).not.toContain('Archived Workflow');
    });

    it('includes archived workflows when includeArchived is true', async () => {
        const tracker = createTracker();
        await tracker.refreshRemoteState();
        const results = await tracker.getLightweightList({ includeArchived: true });

        const names = results.map(w => w.name);
        expect(names).toContain('Active Workflow');
        expect(names).toContain('Archived Workflow');
    });

    it('shows only archived workflows when onlyArchived is true', async () => {
        const tracker = createTracker();
        await tracker.refreshRemoteState();
        const results = await tracker.getLightweightList({ onlyArchived: true });

        const names = results.map(w => w.name);
        expect(names).not.toContain('Active Workflow');
        expect(names).toContain('Archived Workflow');
    });

    it('sets isArchived flag correctly on returned workflows', async () => {
        const tracker = createTracker();
        await tracker.refreshRemoteState();
        const results = await tracker.getLightweightList({ includeArchived: true });

        const active = results.find(w => w.id === 'wf-active');
        const archived = results.find(w => w.id === 'wf-archived');

        expect(active?.isArchived).toBe(false);
        expect(archived?.isArchived).toBe(true);
    });
});

describe('WorkflowStateTracker filename sanitization', () => {
    let tempDir: string | undefined;

    afterEach(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        tempDir = undefined;
    });

    function createTracker() {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n8nac-tracker-'));
        return new WorkflowStateTracker({} as any, {
            directory: tempDir,
            syncInactive: false,
            ignoredTags: [],
            projectId: 'test-project'
        });
    }

    it('sanitizes Windows-invalid characters in workflow filenames', () => {
        const tracker = createTracker();

        expect((tracker as any).safeName('AI Assistant | Email Sender')).toBe('AI Assistant _ Email Sender');
        expect((tracker as any).safeName('db: backup <nightly>?*')).toBe('db_ backup _nightly___');
    });

    it('removes trailing dots and spaces and protects reserved device names', () => {
        const tracker = createTracker();

        expect((tracker as any).safeName('NUL')).toBe('NUL_');
        expect((tracker as any).safeName('report. ')).toBe('report');
        expect((tracker as any).safeName('   ')).toBe('workflow');
    });

    it('recovers a workflow ID from the persisted filename hint when the decorator ID is missing', async () => {
        const tracker = createTracker();

        fs.writeFileSync(
            path.join(tempDir!, 'recovered.workflow.ts'),
            `import { workflow, node, links } from '@n8n-as-code/transformer';

@workflow({
  name: 'Recovered Workflow',
  active: false
})
export class RecoveredWorkflow {
  @node({
    name: 'Webhook',
    type: 'n8n-nodes-base.webhook',
    version: 2.1,
    position: [0, 0]
  })
  Webhook = {
    path: 'recovered',
    httpMethod: 'POST',
    responseMode: 'onReceived',
    responseBinaryPropertyName: 'data'
  };

  @links()
  defineRouting() {}
}
`,
            'utf-8',
        );

        fs.writeFileSync(
            path.join(tempDir!, '.n8n-state.json'),
            JSON.stringify({
                workflows: {
                    'wf-123': {
                        lastSyncedHash: 'abc123',
                        lastSyncedAt: '2026-03-30T12:00:00.000Z',
                        filename: 'recovered.workflow.ts',
                    },
                },
            }),
            'utf-8',
        );

        await tracker.refreshLocalState();

        expect(tracker.getWorkflowIdForFilename('recovered.workflow.ts')).toBe('wf-123');
        expect(tracker.getFilenameForId('wf-123')).toBe('recovered.workflow.ts');
    });

    it('does not recover a persisted workflow ID when the decorator explicitly sets id undefined', async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n8nac-tracker-'));
        fs.writeFileSync(
            path.join(tempDir, 'new-copy.workflow.ts'),
            `import { workflow, node } from '@n8n-as-code/transformer';

@workflow({
  id: undefined,
  name: 'New Copy',
  active: false
})
export class NewCopyWorkflow {
  @node({
    name: 'Webhook',
    type: 'n8n-nodes-base.webhook',
    version: 2.1,
    position: [0, 0]
  })
  Webhook = { path: 'new-copy', httpMethod: 'POST' };
}
`,
            'utf-8',
        );
        fs.writeFileSync(
            path.join(tempDir, '.n8n-state.json'),
            JSON.stringify({
                workflows: {
                    'stale-wf': {
                        lastSyncedHash: 'abc123',
                        lastSyncedAt: '2026-03-30T12:00:00.000Z',
                        filename: 'new-copy.workflow.ts',
                    },
                },
            }),
            'utf-8',
        );

        const tracker = new WorkflowStateTracker({} as any, {
            directory: tempDir,
            syncInactive: false,
            ignoredTags: [],
            projectId: 'test-project',
        });

        expect(tracker.getWorkflowIdForFilename('new-copy.workflow.ts')).toBe('stale-wf');

        await tracker.refreshLocalState();

        expect(tracker.getWorkflowIdForFilename('new-copy.workflow.ts')).toBeUndefined();
        expect(tracker.getFilenameForId('stale-wf')).toBeUndefined();
    });

    it('extracts the workflow id key without matching id text inside decorator string values', async () => {
        const tracker = createTracker();

        fs.writeFileSync(
            path.join(tempDir!, 'order-id.workflow.ts'),
            `import { workflow, node } from '@n8n-as-code/transformer';

@workflow({
  name: 'Order id: x',
  id: 'real-id',
  active: false
})
export class OrderIdWorkflow {
  @node({
    name: 'Webhook',
    type: 'n8n-nodes-base.webhook',
    version: 2.1,
    position: [0, 0]
  })
  Webhook = { path: 'order-id', httpMethod: 'POST' };
}
`,
            'utf-8',
        );

        await tracker.refreshLocalState();

        expect(tracker.getWorkflowIdForFilename('order-id.workflow.ts')).toBe('real-id');
        expect(tracker.getFilenameForId('real-id')).toBe('order-id.workflow.ts');
    });
});

describe('WorkflowStateTracker drift detection', () => {
    // Helper that creates a tracker with a pre-seeded local hash map,
    // bypassing WorkflowTransformerAdapter.hashWorkflow (the full transform
    // pipeline is exercised by integration tests, not here). This isolates the
    // drift-detection logic under test.
    let tempDir: string | undefined;
    let mockClient: N8nApiClient;
    let remoteUpdatedAtValue: string | undefined;

    const writeWorkflowFile = (id: string, name: string) => {
        const ts = [
            "import { workflow } from '@n8n-as-code/transformer';",
            '',
            `@workflow({ id: "${id}", name: "${name}" })`,
            'export {};',
            '',
        ].join('\n');
        fs.writeFileSync(path.join(tempDir!, `${name}.workflow.ts`), ts, 'utf-8');
    };

    const writeState = (
        entries: Record<string, { lastSyncedHash: string; lastSyncedAt?: string; filename?: string }>,
    ) => {
        fs.writeFileSync(
            path.join(tempDir!, '.n8n-state.json'),
            JSON.stringify({ workflows: entries }, null, 2),
            'utf-8',
        );
    };

    const seedLocalHash = (tracker: any, filename: string, hash: string) => {
        // Pre-populate the private cache that refreshLocalState would normally fill.
        // The drift logic only reads from this cache, so seeding it directly is safe.
        tracker.localHashes.set(filename, hash);
    };

    beforeEach(() => {
        vi.resetAllMocks();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n8nac-drift-'));
        remoteUpdatedAtValue = '2026-06-16T22:45:28.755Z';

        mockClient = {
            getAllWorkflows: vi.fn().mockResolvedValue([
                {
                    id: 'wf-1',
                    name: 'Carousel',
                    active: true,
                    isArchived: false,
                    updatedAt: remoteUpdatedAtValue,
                } as IWorkflow,
            ]),
        } as any;
    });

    afterEach(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        vi.resetAllMocks();
        tempDir = undefined;
    });

    function createTracker() {
        return new WorkflowStateTracker(mockClient, {
            directory: tempDir!,
            syncInactive: true,
            ignoredTags: [],
            projectId: 'test-project',
        });
    }

    it('omits drift field when there is no reference state (never synced)', async () => {
        writeWorkflowFile('wf-1', 'Carousel');
        // No .n8n-state.json written.

        const tracker = createTracker();
        await tracker.refreshLocalState();
        seedLocalHash(tracker, 'Carousel.workflow.ts', 'real-local-hash');
        await tracker.refreshRemoteState();
        const results = await tracker.getLightweightList();

        expect(results).toHaveLength(1);
        expect(results[0].status).toBe('TRACKED');
        // No reference state => cannot determine drift.
        expect(results[0].drift).toBeUndefined();
        expect(results[0].lastSyncedAt).toBeUndefined();
        // Remote timestamp is still surfaced when available.
        expect(results[0].remoteUpdatedAt).toBe('2026-06-16T22:45:28.755Z');
    });

    it('reports drift.local=true when local file hash differs from lastSyncedHash', async () => {
        writeWorkflowFile('wf-1', 'Carousel');
        writeState({
            'wf-1': {
                lastSyncedHash: 'old-hash-from-previous-pull',
                lastSyncedAt: '2026-06-16T22:25:13.933Z',
                filename: 'Carousel.workflow.ts',
            },
        });

        const tracker = createTracker();
        await tracker.refreshLocalState();
        seedLocalHash(tracker, 'Carousel.workflow.ts', 'new-local-hash-after-edit');
        await tracker.refreshRemoteState();
        const results = await tracker.getLightweightList();

        expect(results[0].drift).toEqual({ local: true, remote: true });
        expect(results[0].lastSyncedAt).toBe('2026-06-16T22:25:13.933Z');
        expect(results[0].remoteUpdatedAt).toBe('2026-06-16T22:45:28.755Z');
    });

    it('reports drift.remote=false when remote updatedAt equals lastSyncedAt', async () => {
        writeWorkflowFile('wf-1', 'Carousel');
        writeState({
            'wf-1': {
                lastSyncedHash: 'matching-local-hash',
                // Same as mock remote.updatedAt => no remote drift.
                lastSyncedAt: '2026-06-16T22:45:28.755Z',
                filename: 'Carousel.workflow.ts',
            },
        });

        const tracker = createTracker();
        await tracker.refreshLocalState();
        seedLocalHash(tracker, 'Carousel.workflow.ts', 'matching-local-hash');
        await tracker.refreshRemoteState();
        const results = await tracker.getLightweightList();

        expect(results[0].drift).toEqual({ local: false, remote: false });
    });

    it('reports drift.remote=true when remote updatedAt is newer than lastSyncedAt', async () => {
        writeWorkflowFile('wf-1', 'Carousel');
        writeState({
            'wf-1': {
                lastSyncedHash: 'matching-local-hash',
                // Older than mock remote.updatedAt => remote drift.
                lastSyncedAt: '2026-06-16T22:25:13.933Z',
                filename: 'Carousel.workflow.ts',
            },
        });

        const tracker = createTracker();
        await tracker.refreshLocalState();
        seedLocalHash(tracker, 'Carousel.workflow.ts', 'matching-local-hash');
        await tracker.refreshRemoteState();
        const results = await tracker.getLightweightList();

        expect(results[0].drift).toEqual({ local: false, remote: true });
    });

    it('omits drift on EXIST_ONLY_LOCALLY workflows (no remote reference)', async () => {
        writeWorkflowFile('wf-local-only', 'Local');
        // Remote mock returns no workflows.
        mockClient = { getAllWorkflows: vi.fn().mockResolvedValue([]) } as any;

        const tracker = createTracker();
        await tracker.refreshLocalState();
        await tracker.refreshRemoteState();
        const results = await tracker.getLightweightList();

        expect(results[0].status).toBe('EXIST_ONLY_LOCALLY');
        expect(results[0].drift).toBeUndefined();
        expect(results[0].remoteUpdatedAt).toBeUndefined();
    });

    it('caches remote updatedAt in remoteTimestamps when refreshRemoteState runs', async () => {
        writeWorkflowFile('wf-1', 'Carousel');
        const tracker = createTracker();
        await tracker.refreshLocalState();
        await tracker.refreshRemoteState();

        const timestamps = (tracker as any).remoteTimestamps as Map<string, string>;
        expect(timestamps.get('wf-1')).toBe('2026-06-16T22:45:28.755Z');
    });

    it('does not populate drift when state has lastSyncedHash but no lastSyncedAt', async () => {
        // Defensive: should never happen in practice (finalizeSync always writes both),
        // but if it does we should not crash and should skip drift rather than
        // compute a partial signal.
        writeWorkflowFile('wf-1', 'Carousel');
        fs.writeFileSync(
            path.join(tempDir!, '.n8n-state.json'),
            JSON.stringify({
                workflows: { 'wf-1': { lastSyncedHash: 'whatever' } },
            }),
            'utf-8',
        );

        const tracker = createTracker();
        await tracker.refreshLocalState();
        seedLocalHash(tracker, 'Carousel.workflow.ts', 'whatever');
        await tracker.refreshRemoteState();
        const results = await tracker.getLightweightList();

        expect(results[0].drift).toBeUndefined();
    });
});

