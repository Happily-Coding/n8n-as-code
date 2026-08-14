
import { WorkflowTransformerAdapter } from './packages/cli/dist/core/services/workflow-transformer-adapter.js';

const mockWorkflow = {
    name: 'Test Workflow',
    nodes: [
        {
            name: 'Start',
            type: 'n8n-nodes-base.start',
            typeVersion: 1,
            position: [250, 300],
            parameters: {}
        },
        {
            name: 'NoOp',
            type: 'n8n-nodes-base.noOp',
            typeVersion: 1,
            position: [450, 300],
            parameters: {
                someValue: '{{ $json.foo }}'
            }
        }
    ],
    connections: {
        Start: {
            main: [
                [
                    {
                        node: 'NoOp',
                        type: 'main',
                        index: 0
                    }
                ]
            ]
        }
    },
    settings: {
        executionOrder: 'v1'
    }
};

// An agent carrying a fallback model: two sub-nodes on the same ai_languageModel
// input, told apart only by the target input index. The hash has to survive the
// JSON → TS → JSON trip, or drift-check reports permanent false drift on every
// workflow wired this way in the editor.
const fallbackModelWorkflow = {
    name: 'Fallback Model Workflow',
    nodes: [
        {
            name: 'Agent',
            type: '@n8n/n8n-nodes-langchain.agent',
            typeVersion: 1,
            position: [250, 300],
            parameters: { needsFallback: true }
        },
        {
            name: 'Main Model',
            type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
            typeVersion: 1,
            position: [150, 500],
            parameters: {}
        },
        {
            name: 'Backup Model',
            type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
            typeVersion: 1,
            position: [350, 500],
            parameters: {}
        }
    ],
    connections: {
        'Main Model': {
            ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]]
        },
        'Backup Model': {
            ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 1 }]]
        }
    },
    settings: {
        executionOrder: 'v1'
    }
};

// Same wiring, with only the connection source keys inserted in the opposite order.
// A parser that overwrites instead of keying off target.index keeps a different
// single model here than above, so the two fixtures hash differently — which is the
// failure this catches. Two things are deliberately held identical to the fixture
// above, because both feed the hash and would fake a difference: the node array
// (node order is meaningful workflow data) and `name`.
const fallbackModelWorkflowReversed = {
    ...fallbackModelWorkflow,
    connections: {
        'Backup Model': fallbackModelWorkflow.connections['Backup Model'],
        'Main Model': fallbackModelWorkflow.connections['Main Model']
    }
};

async function checkHashStability(workflow, label = workflow.name) {
    console.log(`\n--- ${label} ---`);

    // 1. Hash from JSON (uses format: false, minimal)
    const hash1 = await WorkflowTransformerAdapter.hashWorkflowFromJson(workflow);
    console.log('Hash from JSON (minimal):', hash1);

    // 2. Convert to TypeScript (formatted, verbose)
    const tsCode = await WorkflowTransformerAdapter.convertToTypeScript(workflow, {
        format: true,
        commentStyle: 'verbose'
    });

    // 3. Hash from TS (uses compileToJson)
    const hash2 = await WorkflowTransformerAdapter.hashWorkflow(tsCode);
    console.log('Hash from TS (formatted/verbose):', hash2);

    if (hash1 === hash2) {
        console.log('✅ Hashes are stable!');
        return true;
    }

    console.log('❌ HASH MISMATCH!');

    // Let's investigate why
    const wf1 = await WorkflowTransformerAdapter.compileToJson(
        await WorkflowTransformerAdapter.convertToTypeScript(workflow, { format: false, commentStyle: 'minimal' })
    );
    const wf2 = await WorkflowTransformerAdapter.compileToJson(tsCode);

    const norm1 = WorkflowTransformerAdapter.normalizeForHash(wf1);
    const norm2 = WorkflowTransformerAdapter.normalizeForHash(wf2);

    console.log('Normalized 1 (minimal TS):', JSON.stringify(norm1, null, 2));
    console.log('Normalized 2 (formatted TS):', JSON.stringify(norm2, null, 2));
    return false;
}

async function testHashStability() {
    console.log('--- Testing Hash Stability ---');

    const results = [];
    const fixtures = [
        [mockWorkflow, 'Test Workflow'],
        [fallbackModelWorkflow, 'Fallback Model Workflow'],
        [fallbackModelWorkflowReversed, 'Fallback Model Workflow (reversed source keys)'],
    ];
    for (const [workflow, label] of fixtures) {
        results.push([label, await checkHashStability(workflow, label)]);
    }

    // Both fallback fixtures describe the same wiring, so they must also agree with
    // each other — an order-dependent parser produces two different stable hashes.
    const [a, b] = await Promise.all(
        [fallbackModelWorkflow, fallbackModelWorkflowReversed]
            .map(w => WorkflowTransformerAdapter.hashWorkflowFromJson(w))
    );
    const orderIndependent = a === b;
    console.log(`\n--- Source key order independence ---`);
    console.log(orderIndependent
        ? `✅ Both key orders hash to ${a}`
        : `❌ Key order changes the hash: ${a} vs ${b}`);
    results.push(['source key order independence', orderIndependent]);

    const failed = results.filter(([, ok]) => !ok);
    console.log('');
    if (failed.length > 0) {
        console.log(`❌ ${failed.length}/${results.length} checks failed: ${failed.map(([n]) => n).join(', ')}`);
        process.exitCode = 1;
    } else {
        console.log(`✅ ${results.length}/${results.length} checks passed`);
    }
}

testHashStability().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
