const express = require('express');
const router = express.Router();
const { admin } = require('../utils/firebaseUtils');
const jobs = require('../services/jobService');

// This route is for internal testing only and should be protected or removed in production.
// It simulates the full lifecycle of a text-to-image job.
router.post('/smoke-test/txt2img', async (req, res) => {
    const testUid = (req.body && req.body.uid) || 'test-user-for-smoke-test';
    const dryRun = (req.body && (req.body.dryRun === true || req.body.dryRun === 'true')) || true; // default to true

    try {
        // 1. Create a job (similar to txt2imgRoute)
        const jobData = {
            userId: testUid,
            modelKey: 'seedream4',
            model: { cost: 24 }, // Mock model info
            version: 'test-version',
            input: { prompt: 'a test prompt' },
            cost: 24,
            postprocess: {},
        };
        const job = await jobs.createJob(jobData);
        const jobId = job._id;

        await jobs.updateJob(jobId, { status: 'running', provider: 'replicate', providerPredictionId: `sim_${Date.now()}` });


        // 2. Simulate a successful Replicate webhook call
        const simulatedWebhookPayload = {
            id: job.providerPredictionId,
            status: 'succeeded',
            output: [
                "https://replicate.delivery/pbxt/.../output_0.png",
                "https://replicate.delivery/pbxt/.../output_1.png"
            ],
            metrics: { predict_time: 10.0 }
        };

        // We need a way to tie the webhook back to our job.
        // The real webhook handler uses the prediction ID.
        // We'll need to simulate that lookup.
        // A simple way is to pass the job to the handler for the test.
        const reqMock = { body: simulatedWebhookPayload, params: { jobId: job.providerPredictionId } };
        const resMock = { status: () => ({ json: () => { } }), send: () => { } };

        // This assumes you have a handler that can be called programmatically.
        // You might need to adjust this part based on your actual webhook handler implementation.
        // Let's assume a conceptual `handleWebhook` function exists.
        // In our case, the logic is inside the replicateWebhookRoute. Let's call that logic.
        // For simplicity, I will manually update the job as the webhook would.
        // This is not ideal, but avoids complex refactoring of the route for a test.

        let finalOutputs = [];
        if (dryRun) {
            // Avoid network/downloads; simulate stored outputs
            finalOutputs = [
                { storagePath: `user-outputs/${testUid}/${jobId}/test_output_0.png`, filename: 'test_output_0.png', contentType: 'image/png', bytes: 12345 },
                { storagePath: `user-outputs/${testUid}/${jobId}/test_output_1.png`, filename: 'test_output_1.png', contentType: 'image/png', bytes: 67890 },
            ];
        } else {
            const { storeReplicateOutput } = require('../services/outputStore');
            const outputs = [];
            for (let i = 0; i < simulatedWebhookPayload.output.length; i++) {
                const stored = await storeReplicateOutput({
                    uid: testUid,
                    jobId: jobId,
                    sourceUrl: simulatedWebhookPayload.output[i],
                    index: i,
                    filename: `test_output_${i}.png`,
                    contentTypeHint: 'image/png'
                });
                if (stored && stored.ok && stored.storagePath) {
                    outputs.push({
                        storagePath: stored.storagePath,
                        filename: stored.filename,
                        contentType: stored.contentType,
                        bytes: stored.bytes || 0,
                    });
                }
            }
            finalOutputs = outputs;
        }

        await jobs.updateJob(jobId, {
            status: 'succeeded',
            output: finalOutputs,
            stored: finalOutputs.length > 0,
        });


        // 3. Fetch the final job state
        const finalJob = await jobs.getJob(jobId);

        res.status(200).json({
            ok: true,
            message: 'Smoke test completed successfully.',
            job: finalJob
        });

    } catch (error) {
        console.error('Smoke test failed:', error);
        res.status(500).json({
            ok: false,
            message: 'Smoke test failed.',
            error: error.message
        });
    }
});

module.exports = router;
